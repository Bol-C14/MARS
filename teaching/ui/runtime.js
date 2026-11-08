// Select at build time. The JVM build keeps HTTP; the static build owns two
// independent Java runtimes, so full checking cannot erase a debug session.
export const browserRuntime =
  typeof __MARS_BROWSER__ !== "undefined" && __MARS_BROWSER__;

class KernelWorker {
  constructor(name) {
    this.worker = new Worker(new URL("./kernel-worker.js", import.meta.url), {
      name,
    });
    this.nextId = 0;
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.ready) return resolve();
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        data.error ? job.reject(Object.assign(Error(data.error), { kernel: true })) : job.resolve(data.result);
      };
      this.worker.onerror = (event) => {
        const error = Object.assign(Error(event.message || "Browser kernel could not start"), { kernel: true });
        reject(error);
        for (const job of this.pending.values()) job.reject(error);
        this.pending.clear();
      };
    });
  }
  call(body, check = false) {
    // TeaVM coroutines yield during long runs; ordinary requests remain serial.
    const job = this.tail.then(async () => {
      await this.ready;
      return new Promise((resolve, reject) => {
        const id = ++this.nextId;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, body, check });
      });
    });
    this.tail = job.catch(() => {});
    return job;
  }
  pause() {
    this.worker.postMessage({ pause: true });
  }
}
let debug, checker;
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (path === "/api/check" && [404, 405, 501].includes(response.status))
      return null;
    const detail = await response.json().catch(() => ({}));
    throw Object.assign(Error(detail.error || `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return response.json();
}
export const runtime = {
  command(body) {
    if (!browserRuntime) return post("/api", body);
    return (debug ??= new KernelWorker("MARS debugger")).call(body);
  },
  async check(body) {
    if (!browserRuntime) return post("/api/check", body).catch(() => undefined);
    return (checker ??= new KernelWorker("MARS syntax checker"))
      .call(body, true)
      .catch(() => undefined);
  },
  pause() {
    if (browserRuntime) debug?.pause();
  },
  async examples() {
    const response = await fetch(
      browserRuntime ? "./examples.json" : "/examples",
    );
    if (!response.ok) throw Error("Examples unavailable");
    return response.json();
  },
};
