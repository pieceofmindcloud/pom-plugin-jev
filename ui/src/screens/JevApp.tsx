import { useState } from "react";
import { usePluginI18n } from "../host/runtime";
import { Demo } from "./Demo";
import { Playground } from "./Playground";

type Tab = "playground" | "demo";
const TABS: Tab[] = ["playground", "demo"];
const STORAGE_KEY = "pom-jev.tab";

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "demo" ? "demo" : "playground";
  } catch {
    return "playground";
  }
}

/** The single POM-JEV screen: Playground and Demo as tabs. */
export function JevApp() {
  const { t } = usePluginI18n();
  const [tab, setTab] = useState<Tab>(initialTab);
  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the tab is a convenience only.
    }
  };
  return (
    <div className="pb-page pb-shell">
      <div className="pb-shell-tabs" role="tablist" aria-label="POM-JEV">
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`pb-tab-${value}`}
            aria-selected={tab === value}
            aria-controls="pb-shell-panel"
            className={tab === value ? "pb-shell-tab pb-shell-tab-on" : "pb-shell-tab"}
            onClick={() => choose(value)}
          >
            <span aria-hidden="true">{value === "playground" ? "{ }" : "▶"}</span>
            {t(`tab.${value}`)}
          </button>
        ))}
      </div>
      <div className="pb-shell-panel" id="pb-shell-panel" role="tabpanel" aria-labelledby={`pb-tab-${tab}`}>
        {tab === "playground" ? <Playground /> : <Demo />}
      </div>
    </div>
  );
}
