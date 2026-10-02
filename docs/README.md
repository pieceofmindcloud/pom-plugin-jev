# POM-JEV

JEV turns the model your POM serves into a decision engine. Instead of free
text, you ask **typed questions** about a **state** and get calibrated
probabilities back.

## Question types

| Type | Answer | Criteria |
|---|---|---|
| `noul` | `noul`: probability of "yes", 0 to 1 | optional `{"true": "...", "false": "..."}` |
| `choice` | `choice`, `probabilities` per option, `confidence` | a map of 2 to 26 options to an optional description |
| `score` | `score` (expected level), `legend`, `probabilities`, `confidence` | an ordered array of 2 to 10 levels |

Choice confidence is `(n * pmax - 1) / (n - 1)`: 0 for a uniform answer, 1 for
certainty. Score confidence is `1 - spread / evenSpread`.

## Request

```json
POST /v1/systemone
{
  "model": "optional, the active model by default",
  "state": "text or JSON shared by every question",
  "questions": {
    "is_urgent": {"type": "noul", "instructions": "Does this need urgent handling?"},
    "department": {"type": "choice", "instructions": "Which team?", "criteria": {"billing": "Payments", "technical": null}},
    "frustration": {"type": "score", "instructions": "How frustrated?", "criteria": ["Calm", "Annoyed", "Angry"]}
  }
}
```

The endpoint needs a POM API key. Inside the POM the plugin calls it for you
with the key the POM shares with plugins, so the screens never see a key.
Questions and choice options are processed in key order; answers are keyed by
question id and option name.

## How the POM answers

Each question becomes one chat turn ordered from stable to volatile: a fixed
system turn, the question (instructions and answer format), the state as
compact JSON, then the options with single-token labels (`A`, `B`, ... for choice, `0`..`9` for score,
`Yes`/`No` for noul). The last peer of the pipeline reads the full-vocabulary
probability of each label from the logits before sampling one token, and the
gateway normalizes them. The text before the state is the prefix-cache key,
so asking the same question about a new state (a game loop) only prefills the
state and the options. `x_pom.questions.<id>.label_mass` reports how much of
the probability went to the labels at all: a low value means the model wanted
to say something else, and the answer deserves less trust.

## Screens

One **POM-JEV** menu item opens a screen with two tabs.


- **Playground**: a full-screen editor. The explorer on the left lists the
  state, the whole `request.json` and every question; the centre edits the
  selected item (id, type, instructions, options or levels with add, remove
  and reorder, live validation); the right shows the typed answers with
  probability bars. Examples, model selector, `Ctrl+Enter` to run, copy as
  curl or JSON, and a status bar with the request state.
- **Demo**: Snake played by POM-JEV, drawn on a grass field with a tapered,
  scaled snake that slides between cells. Every request sends only positions
  (head, food and current direction as coordinates, the body as run-length
  steps from the head such as `"D2 L7 U15"`: the same cells as a coordinate
  list in a fraction of the tokens, 96 instead of 421 for a 63-segment snake) and asks one `choice` question over
  the next **1 to 3 moves as a path** (`up`, `up-left`, `up-left-left`, ...;
  "Moves per request"). The plugin simulates each path, so a path stops early
  where the snake eats, "Never offer a fatal move" removes paths that die and
  "Describe each move" states where each path ends (food distance, reachable
  free cells). At most 26 paths are offered, best first. When only one path
  survives there is nothing to decide and the POM is not called. With
  "Request ahead", the next plan is asked from where the current one ends
  while it is still playing; this is skipped when the plan eats, because the
  next food is random. With a plan asked ahead, the moves are paced from the
  measured answer time (never faster than the game's own speed): the plan's
  moves are spread over the time the next answer takes, so the snake moves
  at a steady pace instead of running a plan and stopping to wait. You can
  also play.
