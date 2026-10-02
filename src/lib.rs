//! JEV for the POM: typed decisions (`noul`, `choice`, `score`) over the
//! POM `/v1/systemone` endpoint, with a playground and a live demo.

use serde_json::{json, Value};
use std::ffi::{c_char, c_void};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ABI_VERSION: u32 = 1;
static VERSION: &[u8] = b"0.1.0\0";
const UI_MANIFEST: &str = include_str!("../ui/manifest.json");
/// The POM decision endpoint, relative to the gateway's `/v1` base.
const DECISION_PATH: &str = "/systemone";
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ByteSlice {
    pub ptr: *const u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ByteBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct HostCallbacks {
    pub log: Option<unsafe extern "C" fn(message: ByteSlice)>,
}

pub type PluginHandle = *mut c_void;
pub type CreateFn = unsafe extern "C" fn(HostCallbacks, ByteSlice) -> PluginHandle;
pub type IngestFn = unsafe extern "C" fn(PluginHandle, ByteSlice) -> i32;
pub type QueryFn = unsafe extern "C" fn(PluginHandle, ByteSlice) -> ByteBuffer;
pub type FreeBufferFn = unsafe extern "C" fn(ByteBuffer);
pub type ShutdownFn = unsafe extern "C" fn(PluginHandle);

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct PluginApiV1 {
    pub abi_version: u32,
    pub plugin_version: *const c_char,
    pub capabilities: u64,
    pub create: Option<CreateFn>,
    pub ingest: Option<IngestFn>,
    pub query: Option<QueryFn>,
    pub free_buffer: Option<FreeBufferFn>,
    pub shutdown: Option<ShutdownFn>,
}

unsafe impl Sync for PluginApiV1 {}

struct PluginState {
    gateway: Arc<GatewayState>,
    upstream: Option<DecisionServer>,
}

/// The POM's OpenAI-compatible endpoint and the key minted for this plugin.
#[derive(Clone, PartialEq)]
struct Gateway {
    base_url: String,
    api_key: String,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Gateway")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

/// `{"gateway": {"openai_base_url": "...", "api_key": "..."}}`, when usable.
fn gateway_from(request: &Value) -> Option<Gateway> {
    let gateway = request.get("gateway")?;
    let base_url = gateway
        .get("openai_base_url")?
        .as_str()?
        .trim()
        .trim_end_matches('/');
    let api_key = gateway.get("api_key")?.as_str()?.trim();
    let scheme_ok = base_url.starts_with("http://") || base_url.starts_with("https://");
    (scheme_ok && !api_key.is_empty() && !api_key.chars().any(char::is_whitespace)).then(|| {
        Gateway {
            base_url: base_url.to_owned(),
            api_key: api_key.to_owned(),
        }
    })
}

#[derive(Default)]
struct GatewayState {
    current: RwLock<Option<Gateway>>,
}

impl GatewayState {
    fn get(&self) -> Option<Gateway> {
        self.current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn configure(&self, request: &Value) -> Value {
        let gateway = gateway_from(request);
        let ready = gateway.is_some();
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = gateway;
        json!({"status": "ok", "gateway": ready})
    }
}

/// Loopback server behind `/api/ui/plugins/jev/proxy/*`. The browser never
/// sees the gateway key: this server adds it when it forwards a decision.
struct DecisionServer {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl DecisionServer {
    fn start(gateway: Arc<GatewayState>) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let token = upstream_token(port);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_token = token.clone();
        let thread = thread::Builder::new()
            .name("pom-plugin-jev-upstream".into())
            .spawn(move || serve(listener, gateway, thread_token, thread_stop))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            port,
            token,
            stop,
            thread: Some(thread),
        })
    }

    fn response(&self) -> Value {
        json!({"status": "ready", "port": self.port, "token": self.token})
    }
}

impl Drop for DecisionServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn upstream_token(port: u16) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!("{nanos:032x}{:08x}{port:04x}", std::process::id())
}

fn serve(listener: TcpListener, gateway: Arc<GatewayState>, token: String, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let gateway = Arc::clone(&gateway);
                let token = token.clone();
                // A decision can take seconds; the demo and the playground
                // must not wait behind each other.
                let _ = thread::Builder::new()
                    .name("pom-plugin-jev-request".into())
                    .spawn(move || handle_request(stream, &gateway, &token));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn read_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut parts = lines.next()?.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.split('?').next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY_BYTES {
        return None;
    }
    let mut body = buffer[head_end..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    body.truncate(length);
    Some(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn handle_request(mut stream: TcpStream, gateway: &GatewayState, token: &str) {
    let Some(request) = read_request(&mut stream) else {
        write_json_response(
            &mut stream,
            "400 Bad Request",
            &json!({"error": "bad request"}),
        );
        return;
    };
    if request.header("x-pom-plugin-token") != Some(token) {
        write_json_response(
            &mut stream,
            "401 Unauthorized",
            &json!({"error": "unauthorized"}),
        );
        return;
    }
    let (status, body) = route(&request, gateway);
    write_json_response(&mut stream, &status, &body);
}

fn route(request: &HttpRequest, gateway: &GatewayState) -> (String, Value) {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => (
            "200 OK".into(),
            json!({"gateway": gateway.get().is_some(), "endpoint": DECISION_PATH}),
        ),
        ("GET", "/models") => match gateway.get() {
            Some(gateway) => forward(&gateway, "GET", "/models", None),
            None => no_gateway(),
        },
        ("POST", "/decide") => {
            let Ok(body) = serde_json::from_slice::<Value>(&request.body) else {
                return (
                    "400 Bad Request".into(),
                    json!({"error": {"message": "the request body is not JSON"}}),
                );
            };
            match gateway.get() {
                Some(gateway) => forward(&gateway, "POST", DECISION_PATH, Some(&body)),
                None => no_gateway(),
            }
        }
        _ => ("404 Not Found".into(), json!({"error": "not found"})),
    }
}

fn no_gateway() -> (String, Value) {
    (
        "503 Service Unavailable".into(),
        json!({"error": {"message": "the POM has not shared its gateway with this plugin yet"}}),
    )
}

/// Calls the POM gateway with the plugin key and relays status and JSON body.
fn forward(gateway: &Gateway, method: &str, path: &str, body: Option<&Value>) -> (String, Value) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(600))
        .build();
    let url = format!("{}{path}", gateway.base_url);
    let request = agent
        .request(method, &url)
        .set("Authorization", &format!("Bearer {}", gateway.api_key));
    let result = match body {
        Some(body) => request.send_json(body.clone()),
        None => request.call(),
    };
    let (code, response) = match result {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(code, response)) => (code, response),
        Err(error) => {
            return (
                "502 Bad Gateway".into(),
                json!({"error": {"message": format!("POM gateway unreachable: {error}")}}),
            )
        }
    };
    let text = response.into_string().unwrap_or_default();
    let value =
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"error": {"message": text.trim()}}));
    (format!("{code} {}", reason(code)), value)
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn write_json_response(stream: &mut TcpStream, status: &str, body: &Value) {
    let Ok(body) = serde_json::to_vec(body) else {
        return;
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body);
}

impl PluginState {
    fn new() -> Self {
        let gateway = Arc::new(GatewayState::default());
        let upstream = DecisionServer::start(Arc::clone(&gateway)).ok();
        Self { gateway, upstream }
    }
}

include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));

unsafe fn input_bytes<'a>(input: ByteSlice) -> Result<&'a [u8], String> {
    if input.len == 0 {
        return Ok(&[]);
    }
    if input.ptr.is_null() {
        return Err("null byte slice".into());
    }
    Ok(std::slice::from_raw_parts(input.ptr, input.len))
}

fn ui_asset(path: &str) -> Option<&'static (&'static str, &'static str, &'static [u8])> {
    UI_ASSETS.iter().find(|(name, _, _)| *name == path)
}

fn ui_manifest() -> Result<Value, String> {
    let manifest: Value = serde_json::from_str(UI_MANIFEST).map_err(|error| error.to_string())?;
    let assets = manifest["assets"]
        .as_array()
        .ok_or("manifest has no assets")?;
    for asset in assets.iter().filter_map(Value::as_str) {
        if ui_asset(asset).is_none() {
            return Err(format!("asset is not embedded: {asset}"));
        }
    }
    Ok(manifest)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(TABLE[((value >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

fn query_inner(state: &PluginState, request: &[u8]) -> Result<Value, String> {
    let request: Value = serde_json::from_slice(request).map_err(|error| error.to_string())?;
    match request["operation"].as_str().unwrap_or_default() {
        "host.configure" => Ok(state.gateway.configure(&request)),
        "host.event" => Ok(json!({"status": "ok"})),
        "ui.upstream" => state
            .upstream
            .as_ref()
            .map(DecisionServer::response)
            .ok_or_else(|| "decision upstream is unavailable".into()),
        "ui.manifest" => ui_manifest(),
        "ui.asset" => {
            let path = request["path"].as_str().ok_or("asset path is missing")?;
            let (_, content_type, bytes) = ui_asset(path).ok_or("unknown asset")?;
            Ok(json!({"content_type": content_type, "base64": encode_base64(bytes)}))
        }
        _ => Err("unknown operation".into()),
    }
}

fn buffer_from_bytes(bytes: Vec<u8>) -> ByteBuffer {
    let mut bytes = bytes.into_boxed_slice();
    let buffer = ByteBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
    };
    std::mem::forget(bytes);
    buffer
}

unsafe extern "C" fn create(_: HostCallbacks, config: ByteSlice) -> PluginHandle {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let config = input_bytes(config)?;
        if !config.is_empty() {
            serde_json::from_slice::<Value>(config).map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(Box::into_raw(Box::new(PluginState::new())).cast::<c_void>())
    }));
    match result {
        Ok(Ok(handle)) => handle,
        _ => std::ptr::null_mut(),
    }
}

unsafe extern "C" fn ingest(handle: PluginHandle, event: ByteSlice) -> i32 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return false;
        }
        input_bytes(event).is_ok()
    }));
    matches!(result, Ok(true)).then_some(0).unwrap_or(-1)
}

unsafe extern "C" fn query(handle: PluginHandle, request: ByteSlice) -> ByteBuffer {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return Err("plugin handle is null".to_owned());
        }
        query_inner(&*handle.cast::<PluginState>(), input_bytes(request)?)
            .and_then(|value| serde_json::to_vec(&value).map_err(|error| error.to_string()))
    }));
    match result {
        Ok(Ok(bytes)) => buffer_from_bytes(bytes),
        _ => ByteBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        },
    }
}

unsafe extern "C" fn free_buffer(buffer: ByteBuffer) {
    if !buffer.ptr.is_null() {
        let slice = std::ptr::slice_from_raw_parts_mut(buffer.ptr, buffer.len);
        drop(Box::from_raw(slice));
    }
}

unsafe extern "C" fn shutdown(handle: PluginHandle) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !handle.is_null() {
            drop(Box::from_raw(handle.cast::<PluginState>()));
        }
    }));
}

static API: PluginApiV1 = PluginApiV1 {
    abi_version: ABI_VERSION,
    plugin_version: VERSION.as_ptr().cast(),
    capabilities: 0,
    create: Some(create),
    ingest: Some(ingest),
    query: Some(query),
    free_buffer: Some(free_buffer),
    shutdown: Some(shutdown),
};

#[no_mangle]
pub unsafe extern "C" fn pom_jev_plugin_v1() -> *const PluginApiV1 {
    &API
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_exposes_the_generic_v1_boundary() {
        let api = unsafe { &*pom_jev_plugin_v1() };
        assert_eq!(api.abi_version, ABI_VERSION);
        assert_eq!(api.capabilities, 0);
        assert!(api.create.is_some());
        assert!(api.ingest.is_some());
        assert!(api.query.is_some());
        assert!(api.free_buffer.is_some());
        assert!(api.shutdown.is_some());
    }

    #[test]
    fn buffer_encoding_uses_standard_padding() {
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn manifest_resolves_all_built_assets() {
        let manifest: Value = serde_json::from_str(UI_MANIFEST).unwrap();
        if ui_asset("ui/screens.js").is_some() {
            assert!(ui_manifest().is_ok());
            for asset in manifest["assets"].as_array().unwrap() {
                assert!(ui_asset(asset.as_str().unwrap()).is_some());
            }
        } else {
            assert!(ui_manifest().is_err());
        }
    }

    #[test]
    fn host_configure_reads_the_gateway_and_hides_its_key() {
        let state = GatewayState::default();
        let reply = state.configure(&json!({
            "gateway": {"openai_base_url": "http://127.0.0.1:8080/v1/", "api_key": "sk-pom"}
        }));
        assert_eq!(reply, json!({"status": "ok", "gateway": true}));
        let gateway = state.get().unwrap();
        assert_eq!(gateway.base_url, "http://127.0.0.1:8080/v1");
        assert!(!format!("{gateway:?}").contains("sk-pom"));
        for bad in [
            json!({"gateway": {"openai_base_url": "file:///etc", "api_key": "k"}}),
            json!({"gateway": {"openai_base_url": "http://x/v1", "api_key": " "}}),
            json!({"workspace_root": "/tmp"}),
        ] {
            assert_eq!(state.configure(&bad)["gateway"], false);
            assert!(state.get().is_none());
        }
    }

    fn call(port: u16, raw: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        reply
    }

    /// One-shot fake POM gateway that answers `/v1/systemone`.
    fn fake_gateway() -> (u16, JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream).unwrap();
            let seen = format!(
                "{} {} {} {}",
                request.method,
                request.path,
                request.header("authorization").unwrap_or_default(),
                String::from_utf8_lossy(&request.body)
            );
            write_json_response(
                &mut stream,
                "200 OK",
                &json!({"answers": {"move": {"type": "choice", "choice": "up"}}}),
            );
            seen
        });
        (port, handle)
    }

    #[test]
    fn decide_forwards_to_systemone_with_the_plugin_key() {
        let (gateway_port, seen) = fake_gateway();
        let gateway = Arc::new(GatewayState::default());
        gateway.configure(&json!({"gateway": {
            "openai_base_url": format!("http://127.0.0.1:{gateway_port}/v1"),
            "api_key": "sk-plugin"
        }}));
        let server = DecisionServer::start(Arc::clone(&gateway)).unwrap();

        let unauthorized = call(server.port, "GET /status HTTP/1.1\r\n\r\n");
        assert!(unauthorized.starts_with("HTTP/1.1 401"));

        let body = r#"{"state":"s","questions":{"move":{"type":"choice","options":{"up":"u"}}}}"#;
        let reply = call(
            server.port,
            &format!(
                "POST /decide HTTP/1.1\r\nx-pom-plugin-token: {}\r\nContent-Length: {}\r\n\r\n{body}",
                server.token,
                body.len()
            ),
        );
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("\"choice\":\"up\""));
        let seen = seen.join().unwrap();
        assert!(
            seen.starts_with("POST /v1/systemone Bearer sk-plugin "),
            "{seen}"
        );
        assert!(seen.contains("\"questions\""));
    }

    #[test]
    fn decide_without_a_gateway_is_unavailable() {
        let server = DecisionServer::start(Arc::new(GatewayState::default())).unwrap();
        let reply = call(
            server.port,
            &format!(
                "POST /decide HTTP/1.1\r\nx-pom-plugin-token: {}\r\nContent-Length: 2\r\n\r\n{{}}",
                server.token
            ),
        );
        assert!(reply.starts_with("HTTP/1.1 503"), "{reply}");
        let status = call(
            server.port,
            &format!(
                "GET /status HTTP/1.1\r\nx-pom-plugin-token: {}\r\n\r\n",
                server.token
            ),
        );
        assert!(status.contains("\"gateway\":false"));
    }
}
