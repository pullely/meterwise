// stdin prompt for the token-paste login flow.
//
// Reads a single line from stdin without echoing it. On TTYs we toggle
// raw + opaque mode so the pasted token doesn't appear; on non-TTYs (CI,
// `echo … | meterwise login`) we read line-by-line.
//
// Kept tiny — no readline dep — to avoid a transitive `node:readline`
// surface that could trip the package-loadability constraint. The
// function is only invoked from the `login` command path, never from
// the package index.

export async function readBearerTokenFromStdin(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return readLineNonTty(stdin);
  }
  return readLineTty(stdin);
}

function readLineNonTty(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        cleanup();
        resolve(buffer.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buffer.replace(/\r?\n$/, ""));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

function readLineTty(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw === true;
    let buffer = "";
    const setRaw = (value: boolean): void => {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(value);
    };
    const restore = (): void => {
      stdin.off("data", onData);
      stdin.off("error", onError);
      setRaw(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          restore();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          restore();
          reject(new Error("aborted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    const onError = (err: Error): void => {
      restore();
      reject(err);
    };
    setRaw(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}
