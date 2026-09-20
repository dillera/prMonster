// The "Deep analysis" tab: dossier, run panel, brief, stacked in that order
// (DESIGN-deep.md, UI section). This component owns the data loading and the live
// deep:* events; the three sections below it are presentational.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DeepRun, DeepStep, Dossier, PrSnapshot } from "../../shared/types";
import { ApiError, getDeepModels, getDeepRuns, getDeepSpend, getDossier, startDeepRun, stopDeepRun, subscribeEvents } from "../lib/api";
import type { DeepModelsResponse, DeepSpend } from "../lib/api";
import { BriefView } from "./deep/BriefView";
import { DossierUnavailable, DossierView } from "./deep/DossierView";
import { RunPanel } from "./deep/RunPanel";
import { Skeleton } from "./ui";

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function DeepPanel({
  snapshot,
  repo,
  onUseAsProposal,
  usingProposal,
  usedRunId,
}: {
  snapshot: PrSnapshot;
  repo: string;
  onUseAsProposal: (runId: string, reply: string) => void;
  usingProposal: boolean;
  usedRunId: string | null;
}) {
  const n = snapshot.number;

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierError, setDossierError] = useState<string | null>(null);
  const [dossierLoading, setDossierLoading] = useState(true);

  const [runs, setRuns] = useState<DeepRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<Record<string, DeepStep[]>>({});
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [models, setModels] = useState<DeepModelsResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [spend, setSpend] = useState<DeepSpend | null>(null);

  const [dossierReloads, setDossierReloads] = useState(0);

  // ---------------------------------------------------------------- loading
  const loadDossier = useCallback(
    (refresh = false) => {
      setDossierLoading(true);
      setDossierError(null);
      getDossier(n, refresh)
        .then((d) => {
          setDossier(d);
          setDossierError(null);
        })
        .catch((err: unknown) => {
          setDossier(null);
          setDossierError(messageOf(err, "The dossier could not be built."));
        })
        .finally(() => setDossierLoading(false));
    },
    [n],
  );

  useEffect(() => {
    loadDossier(dossierReloads > 0);
  }, [loadDossier, dossierReloads]);

  const loadRuns = useCallback(() => {
    getDeepRuns(n)
      .then(({ latest, history }) => {
        const all = latest ? [latest, ...history.filter((r) => r.id !== latest.id)] : history;
        setRuns(all);
        setSelectedRunId((prev) => (prev && all.some((r) => r.id === prev) ? prev : (all[0]?.id ?? null)));
      })
      .catch((err: unknown) => setRunError(messageOf(err, "Could not load the deep analysis history.")));
  }, [n]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    let cancelled = false;
    getDeepModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) setModelsError(messageOf(err, "The model list is unavailable."));
      });
    getDeepSpend()
      .then((s) => {
        if (!cancelled) setSpend(s);
      })
      .catch(() => {
        /* the spend line simply reads "unknown" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------- live events
  useEffect(() => {
    const unsubscribe = subscribeEvents((event) => {
      if (!("runId" in event) || event.n !== n) return;
      switch (event.type) {
        case "deep:start":
          setRunError(null);
          loadRuns();
          break;
        case "deep:step":
          setLiveSteps((prev) => ({
            ...prev,
            [event.runId]: [...(prev[event.runId] ?? []), event.step],
          }));
          setRuns((prev) =>
            prev.map((r) =>
              r.id === event.runId
                ? { ...r, steps: [...r.steps.filter((s) => s.index !== event.step.index), event.step] }
                : r,
            ),
          );
          break;
        case "deep:done":
          setRuns((prev) => {
            const without = prev.filter((r) => r.id !== event.runId);
            return [event.run, ...without];
          });
          setSelectedRunId(event.runId);
          getDeepSpend()
            .then(setSpend)
            .catch(() => {
              /* keep the previous number */
            });
          break;
        case "deep:error":
          setRunError(event.error);
          loadRuns();
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [n, loadRuns]);

  // ---------------------------------------------------------------- actions
  const onRun = useCallback(
    (model: string, requestedBy: string) => {
      setStarting(true);
      setRunError(null);
      startDeepRun(n, { model, requestedBy })
        .then((run) => {
          setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
          setSelectedRunId(run.id);
        })
        .catch((err: unknown) => setRunError(messageOf(err, "The deep run could not be started.")))
        .finally(() => setStarting(false));
    },
    [n],
  );

  const running = runs.find((r) => r.status === "running") ?? null;

  const onStop = useCallback(() => {
    if (!running) return;
    setRunError(null);
    stopDeepRun(n, running.id)
      .then((run) => {
        if (run) setRuns((prev) => prev.map((r) => (r.id === run.id ? run : r)));
        else loadRuns();
      })
      .catch((err: unknown) => setRunError(messageOf(err, "The run could not be stopped.")));
  }, [n, running, loadRuns]);

  // ---------------------------------------------------------------- render
  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? running ?? runs[0] ?? null,
    [runs, selectedRunId, running],
  );

  const gitAvailable = dossier?.availability.git ?? false;
  const gitReason = dossier
    ? (dossier.availability.notes[0] ?? "git is not available on the server.")
    : (dossierError ?? "The dossier has not been built yet, so the analysis tools have nothing to read.");

  return (
    <div className="deep">
      {dossierLoading && !dossier ? (
        <section className="dossier" aria-label="Dossier">
          <Skeleton lines={6} />
        </section>
      ) : dossier ? (
        <DossierView dossier={dossier} repo={repo} prAuthor={snapshot.author} />
      ) : (
        <DossierUnavailable
          message={dossierError ?? "No dossier."}
          onRetry={() => setDossierReloads((v) => v + 1)}
        />
      )}

      <RunPanel
        prNumber={n}
        models={models}
        modelsError={modelsError}
        spend={spend}
        gitAvailable={gitAvailable}
        gitReason={gitReason}
        run={selectedRun}
        liveSteps={selectedRun ? (liveSteps[selectedRun.id] ?? []) : []}
        onRun={onRun}
        onStop={onStop}
        starting={starting}
        runError={runError}
        history={runs}
        onSelectRun={setSelectedRunId}
        selectedRunId={selectedRun?.id ?? null}
      />

      <BriefView
        run={selectedRun}
        repo={repo}
        baseSha={dossier?.baseSha ?? snapshot.headSha}
        onUseAsProposal={onUseAsProposal}
        usingProposal={usingProposal}
        usedRunId={usedRunId}
      />
    </div>
  );
}
