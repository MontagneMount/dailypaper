// Web requests for the helper scripts: each has a time limit, so a slow server cannot hang a
// command, and errors say in plain words what failed.

const HEADERS = { "User-Agent": "dailypaper (https://github.com/MontagneMount/dailypaper)" };

/**
 * GET a URL and read the answer as "text", "json" or "bytes" (a Buffer), giving up after `seconds`.
 * `what` names the source in error messages, e.g. "arXiv 接口". Tests pass their own `fetchImpl`.
 */
export async function httpGet(url, { what, seconds, as = "text", fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(seconds * 1000) });
    if (response.ok) return await readBody(response, as);
  } catch (error) {
    throw new Error(describeFailure(error, what, seconds));
  }
  throw new Error(`${what}返回 ${response.status}，过一会儿再试`);
}

async function readBody(response, as) {
  if (as === "json") return response.json();
  if (as === "bytes") return Buffer.from(await response.arrayBuffer());
  return response.text();
}

function describeFailure(error, what, seconds) {
  // The time limit also covers reading the body, so a download that stalls halfway ends here too.
  if (error.name === "TimeoutError" || error.name === "AbortError") return `${what}超过 ${seconds} 秒没有回应，过一会儿再试`;
  if (error instanceof SyntaxError) return `${what}的数据异常：返回的不是 JSON，过一会儿再试`;
  const reason = error.cause?.code ?? error.cause?.message ?? error.message;
  return `${what}连不上（${reason}），检查网络后再试`;
}
