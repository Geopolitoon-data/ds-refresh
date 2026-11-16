// Runs Python and SQL with Pyodide, off the page's main thread so a stuck loop can be stopped.
// "prep" downloads what an attempt needs (sqlite3, numpy, pandas, scikit-learn...) without a time limit;
// "run" then executes the attempt under the page's time limit.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

let py = null;
const ready = (async () => {
  py = await loadPyodide();
  for (const f of ["runner.py", "runtime.py"]) {
    py.FS.writeFile(f, await (await fetch(f)).text());
  }
  py.runPython("import sys; sys.path.insert(0, '.'); import runtime");
  postMessage({ type: "ready" });
})().catch(e => postMessage({ type: "failed", error: String(e) }));

let sqlLoaded = false;
onmessage = async ({ data: job }) => {
  try {
    await ready;
    if (job.type === "prep") {
      if (job.lang === "sql") {
        if (!sqlLoaded) { await py.loadPackage("sqlite3"); sqlLoaded = true; }
      } else {
        await py.loadPackagesFromImports(job.code);
      }
      postMessage({ type: "prepped", id: job.id });
      return;
    }
    const rt = py.pyimport("runtime");
    let res;
    if (job.lang === "sql") {
      res = rt.run_sql(job.seed, job.code, job.solution ?? null, !!job.ordered);
    } else {
      res = rt.run_python(job.code, job.setup || "", py.toPy(job.checks || []), job.mode || "run");
    }
    postMessage({ type: "result", id: job.id, res: res.toJs({ dict_converter: Object.fromEntries }) });
    res.destroy();
  } catch (e) {
    postMessage({ type: job.type === "prep" ? "prepped" : "result", id: job.id, res: { ok: false, error: String(e) } });
  }
};
