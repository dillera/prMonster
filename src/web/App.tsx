// FujiNet PR triage dashboard (DESIGN.md 7).
//
// Routing is location.hash only: #/ , #/pr/1650 , #/audit , #/policy , #/admin.
// All decision maths lives on the server; this app displays stored evaluations and
// asks /api/decide whenever a trial policy needs re-deciding.

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ActionRecord,
  Decision,
  Evaluation,
  Policy,
  PrListItem,
  Proposal,
  TriageState,
} from "../shared/types";
import type { ActionRequest, HarnessEvent, HealthInfo, StatsSummary } from "./lib/api";
import {
  ApiError,
  FIXTURES_MODE,
  decidePreview,
  getHealth,
  getPolicy,
  getProposal,
  getStats,
  listActions,
  listClosedPrs,
  listPrs,
  getPr,
  postAction,
  savePolicy,
  setTriage,
  startScan,
  useScanEvents,
} from "./lib/api";
import { DEFAULT_REPO } from "./github";
import { AdminPage } from "./components/AdminPage";
import { AuditLog } from "./components/AuditLog";
import { DetailPanel } from "./components/DetailPanel";
import { Header, MockBanner } from "./components/Header";
import { PolicyEditor } from "./components/PolicyEditor";
import { ClosedPrList, PrList, kindOf, sortItems } from "./components/PrList";
import type { SortKey } from "./components/PrList";
import type { DecisionFilter } from "./components/StatsRow";
import { StatsRow } from "./components/StatsRow";
import { ErrorNote } from "./components/ui";

// ---------------------------------------------------------------- routing
type View = "list" | "pr" | "audit" | "policy" | "admin";
interface Route {
  view: View;
  n: number | null;
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  if (clean.startsWith("pr/")) {
    const n = Number.parseInt(clean.slice(3), 10);
    return Number.isFinite(n) ? { view: "pr", n } : { view: "list", n: null };
  }
  if (clean === "audit") return { view: "audit", n: null };
  if (clean === "policy") return { view: "policy", n: null };
  if (clean === "admin") return { view: "admin", n: null };
  return { view: "list", n: null };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

const FALLBACK_POLICY: Policy = {
  readyThreshold: 75,
  reviewThreshold: 45,
  confidenceFloor: 0.5,
  maxUncertainNouls: 2,
  softGatePenalty: 6,
  skipJevWhenBlocked: false,
  weights: {},
  hardBlocks: {},
  gates: {},
  jev: { model: "jev-latest", maxStateTokens: 24000, maxChunksPerPr: 12, concurrency: 2 },
};

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

// ---------------------------------------------------------------- app
export function App() {
  const route = useHashRoute();

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [policy, setPolicy] = useState<Policy>(FALLBACK_POLICY);
  const [prs, setPrs] = useState<PrListItem[]>([]);
  const [closedPrs, setClosedPrs] = useState<PrListItem[]>([]);
  /** A PR opened by URL that is in neither list, fetched on its own. */
  const [fetchedItem, setFetchedItem] = useState<PrListItem | null>(null);
  const [prsLoading, setPrsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filters, setFilters] = useState<Set<DecisionFilter>>(new Set());
  const [sort, setSort] = useState<SortKey>("decision");
  const [query, setQuery] = useState("");

  const [force, setForce] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [deepProposalRunId, setDeepProposalRunId] = useState<string | null>(null);
  const [usingDeepProposal, setUsingDeepProposal] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<number, ActionRecord>>({});

  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);

  const [lastSelected, setLastSelected] = useState<number | null>(null);
  const [draftPolicy, setDraftPolicy] = useState<Policy | null>(null);
  const [previewDecision, setPreviewDecision] = useState<Decision | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ------------------------------------------------------------ initial load
  const refreshList = useCallback(async (): Promise<void> => {
    const [items, nextStats] = await Promise.all([listPrs(), getStats()]);
    setPrs(items);
    setStats(nextStats);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listClosedPrs()
      .then((items) => {
        if (!cancelled) setClosedPrs(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        /* the closed section is secondary: if it cannot load, it stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPrsLoading(true);
    Promise.all([getHealth(), getPolicy(), listPrs(), getStats()])
      .then(([h, p, items, s]) => {
        if (cancelled) return;
        setHealth(h);
        setPolicy(p);
        setPrs(items);
        setStats(s);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err, "Could not load the dashboard."));
      })
      .finally(() => {
        if (!cancelled) setPrsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------------------ live events
  const onScanEvent = useCallback(
    (event: HarnessEvent): void => {
      if (event.type === "pr:done") {
        const evaluation: Evaluation = event.evaluation;
        setPrs((prev) =>
          prev.map((item) => (item.snapshot.number === event.n ? { ...item, evaluation, stale: false } : item)),
        );
      }
      if (event.type === "scan:done") {
        setScanning(false);
        void refreshList().catch(() => {
          /* keep whatever the events delivered */
        });
      }
    },
    [refreshList],
  );

  const progress = useScanEvents(onScanEvent);

  // ------------------------------------------------------------ selection
  const selected = route.view === "pr" ? route.n : lastSelected;

  useEffect(() => {
    if (route.view === "pr" && route.n !== null) setLastSelected(route.n);
  }, [route.view, route.n]);

  const selectedItem = useMemo(() => {
    if (selected === null) return null;
    return (
      prs.find((item) => item.snapshot.number === selected) ??
      closedPrs.find((item) => item.snapshot.number === selected) ??
      (fetchedItem?.snapshot.number === selected ? fetchedItem : null)
    );
  }, [prs, closedPrs, fetchedItem, selected]);

  // #/pr/N for a pull request in neither list: fetch it on its own rather than
  // telling the reader it does not exist. Closed PRs keep their evaluations,
  // dossier and deep runs, and a link to one should still work.
  useEffect(() => {
    if (route.view !== "pr" || route.n === null) return;
    const n = route.n;
    if (prsLoading) return;
    if (prs.some((i) => i.snapshot.number === n) || closedPrs.some((i) => i.snapshot.number === n)) return;
    if (fetchedItem?.snapshot.number === n) return;
    let cancelled = false;
    getPr(n)
      .then(({ snapshot, evaluation }) => {
        if (!cancelled) setFetchedItem({ snapshot, evaluation, stale: false, triage: null });
      })
      .catch(() => {
        if (!cancelled) setFetchedItem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, route.n, prs, closedPrs, prsLoading, fetchedItem]);

  // Proposal for the selected PR. The evaluation id is a dependency: a
  // re-evaluation replaces the stored evaluation, and the draft action belongs to
  // that evaluation's head sha, so a stale draft must not linger.
  const selectedEvaluationId = selectedItem?.evaluation?.id ?? null;

  useEffect(() => {
    if (route.view !== "pr" || route.n === null) return;
    const n = route.n;
    let cancelled = false;
    setProposal(null);
    setProposalError(null);
    setProposalLoading(true);
    setDeepProposalRunId(null);
    getProposal(n)
      .then((p) => {
        if (!cancelled) setProposal(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProposalError(errorText(err, "No draft action for this pull request."));
      })
      .finally(() => {
        if (!cancelled) setProposalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, route.n, selectedEvaluationId]);

  // audit log
  const refreshActions = useCallback((): void => {
    setActionsLoading(true);
    setActionsError(null);
    listActions()
      .then(setActions)
      .catch((err: unknown) => setActionsError(errorText(err, "Could not load the audit log.")))
      .finally(() => setActionsLoading(false));
  }, []);

  useEffect(() => {
    if (route.view === "audit") refreshActions();
  }, [route.view, refreshActions]);

  // ------------------------------------------------------------ actions
  const onScan = useCallback((): void => {
    setScanning(true);
    setScanError(null);
    startScan({ force }).catch((err: unknown) => {
      setScanning(false);
      setScanError(errorText(err, "The scan could not be started."));
    });
  }, [force]);

  const onReevaluate = useCallback((n: number): void => {
    setScanning(true);
    setScanError(null);
    startScan({ force: true, numbers: [n] }).catch((err: unknown) => {
      setScanning(false);
      setScanError(errorText(err, `PR ${n} could not be re-evaluated.`));
    });
  }, []);

  const onTriage = useCallback(
    async (n: number, status: TriageState["status"], note?: string): Promise<void> => {
      try {
        const state = await setTriage(n, note === undefined ? { status } : { status, note });
        setPrs((prev) => prev.map((item) => (item.snapshot.number === n ? { ...item, triage: state } : item)));
      } catch (err: unknown) {
        setScanError(errorText(err, "Could not save the local triage state."));
      }
    },
    [],
  );

  const onSend = useCallback(async (n: number, request: ActionRequest): Promise<ActionRecord> => {
    const record = await postAction(n, request);
    setRecords((prev) => ({ ...prev, [n]: record }));
    setActions((prev) => [record, ...prev]);
    return record;
  }, []);

  /** Load a deep run's draft reply into the action panel (DESIGN-deep.md, UI 3). */
  const onUseAsProposal = useCallback((n: number, runId: string): void => {
    setUsingDeepProposal(true);
    setProposalError(null);
    getProposal(n, runId)
      .then((p) => {
        setProposal(p);
        setDeepProposalRunId(runId);
        document.querySelector(".action")?.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch((err: unknown) => setProposalError(errorText(err, "The brief could not be loaded as a proposal.")))
      .finally(() => setUsingDeepProposal(false));
  }, []);

  // ------------------------------------------------------------ policy preview
  const onPreview = useCallback(
    (draft: Policy): void => {
      const item = prs.find((p) => p.snapshot.number === selected) ?? prs.find((p) => p.evaluation) ?? null;
      const evaluation = item?.evaluation;
      if (!evaluation) {
        setPreviewDecision(null);
        return;
      }
      setPreviewing(true);
      setPreviewError(null);
      decidePreview(evaluation, draft)
        .then(setPreviewDecision)
        .catch((err: unknown) => setPreviewError(errorText(err, "The preview decision failed.")))
        .finally(() => setPreviewing(false));
    },
    [prs, selected],
  );

  const onSavePolicy = useCallback(
    async (draft: Policy): Promise<void> => {
      setSavingPolicy(true);
      setSaveError(null);
      try {
        const saved = await savePolicy(draft);
        setPolicy(saved);
        setDraftPolicy(null);
        setPreviewDecision(null);

        // Re-derive every stored decision under the saved policy: a pure server
        // call per evaluation, no Jev traffic.
        const updated = await Promise.all(
          prs.map(async (item) => {
            if (!item.evaluation) return item;
            try {
              const decision = await decidePreview(item.evaluation, saved);
              return { ...item, evaluation: { ...item.evaluation, decision } };
            } catch {
              return item;
            }
          }),
        );
        setPrs(updated);
        try {
          setStats(await getStats());
        } catch {
          /* leave the previous stats in place */
        }
      } catch (err: unknown) {
        setSaveError(errorText(err, "The policy could not be saved."));
      } finally {
        setSavingPolicy(false);
      }
    },
    [prs],
  );

  // ------------------------------------------------------------ derived list
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = prs.filter((item) => {
      if (filters.size > 0 && !filters.has(kindOf(item))) return false;
      if (!q) return true;
      const haystack = [
        String(item.snapshot.number),
        item.snapshot.title,
        item.snapshot.author,
        ...item.snapshot.labels,
        ...item.snapshot.files.slice(0, 40).map((f) => f.path),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    return sortItems(filtered, sort);
  }, [prs, filters, query, sort]);

  const toggleFilter = useCallback((filter: DecisionFilter): void => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  }, []);

  const drawerOpen = route.view === "policy";
  const activePolicy = drawerOpen && draftPolicy ? draftPolicy : policy;

  const closeDrawer = useCallback((): void => {
    setDraftPolicy(null);
    setPreviewDecision(null);
    window.location.hash = lastSelected ? `#/pr/${lastSelected}` : "#/";
  }, [lastSelected]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  return (
    <div className={`app${drawerOpen ? " app--drawer" : ""}`}>
      <a className="skiplink" href="#main">
        Skip to content
      </a>

      <Header
        health={health}
        stats={stats}
        progress={progress}
        force={force}
        onForceChange={setForce}
        onScan={onScan}
        scanning={scanning}
        scanError={scanError}
        route={route.view}
      />

      {health ? <MockBanner health={health} /> : null}

      {loadError ? (
        <div className="app__error">
          <ErrorNote message={loadError} onRetry={() => window.location.reload()} />
          {!FIXTURES_MODE ? (
            <p className="app__errorhint mono">
              Start the harness with npm run dev, or run the dashboard alone with VITE_FIXTURES=1 npm run dev:web.
            </p>
          ) : null}
        </div>
      ) : null}

      <StatsRow stats={stats} filters={filters} onToggle={toggleFilter} progress={progress} />

      <main
        id="main"
        className={`layout${route.view === "pr" ? " layout--detail" : ""}${
          route.view === "audit" || route.view === "admin" ? " layout--audit" : ""
        }`}
      >
        {route.view === "admin" ? (
          <AdminPage />
        ) : route.view === "audit" ? (
          <AuditLog records={actions} loading={actionsLoading} error={actionsError} onRefresh={refreshActions} />
        ) : (
          <>
            <div className="layout__list">
              <PrList
                items={visible}
                loading={prsLoading}
                policy={activePolicy}
                selected={selected}
                filters={filters}
                onClearFilters={() => setFilters(new Set())}
                sort={sort}
                onSortChange={setSort}
                query={query}
                onQueryChange={setQuery}
                progress={progress}
              />
              <ClosedPrList items={closedPrs} policy={activePolicy} selected={selected} />
            </div>
            <div className="layout__detail">
              <DetailPanel
                item={selectedItem}
                loading={prsLoading && selected !== null}
                policy={activePolicy}
                previewDecision={drawerOpen ? previewDecision : null}
                health={health}
                proposal={proposal}
                proposalLoading={proposalLoading}
                proposalError={proposalError}
                lastRecord={selected !== null ? (records[selected] ?? null) : null}
                onReevaluate={onReevaluate}
                onTriage={onTriage}
                onSend={onSend}
                scanning={scanning || progress.running}
                repo={health?.repo ?? DEFAULT_REPO}
                onUseAsProposal={onUseAsProposal}
                usingDeepProposal={usingDeepProposal}
                deepProposalRunId={deepProposalRunId}
              />
            </div>
          </>
        )}
      </main>

      {drawerOpen ? (
        <>
          <div className="backdrop" onClick={closeDrawer} role="presentation" />
          <PolicyEditor
            policy={policy}
            previewItem={selectedItem ?? prs.find((p) => p.evaluation) ?? null}
            previewDecision={previewDecision}
            previewing={previewing}
            previewError={previewError}
            onPreview={onPreview}
            onDraftChange={setDraftPolicy}
            onSave={onSavePolicy}
            onClose={closeDrawer}
            saving={savingPolicy}
            saveError={saveError}
          />
        </>
      ) : null}

      <footer className="foot">
        <span className="mono">
          {health ? `${health.repo} · jev ${health.model} · github ${health.githubAuth}` : "connecting"}
        </span>
        <span className="foot__note">
          Read only by default. Every GitHub write is one human confirmed action, and merging is never offered.
        </span>
      </footer>
    </div>
  );
}
