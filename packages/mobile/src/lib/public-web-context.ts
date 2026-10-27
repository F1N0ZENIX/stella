/** Public read-only web context for Stella Groq. No authentication tokens or private repositories. */
const MAX_CONTEXT = 14000;
const TIMEOUT_MS = 12000;
const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'，。]+/gi;
const githubRepo = (url: URL): { owner: string; repo: string; path: string[] } | null => {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !parts.slice(0, 2).every(x => /^[a-zA-Z0-9_.-]+$/.test(x))) return null;
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/, ""), path: parts.slice(2) };
};
const getText = async (url: string, accept = "text/plain"): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: accept }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).slice(0, 120000);
  } finally { clearTimeout(timer); }
};
const plainHtml = (html: string): string => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();
export const readPublicWebContext = async (question: string): Promise<string> => {
  const urls = Array.from(new Set(question.match(URL_PATTERN) ?? [])).slice(0, 2);
  const snippets: string[] = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[.,;!?]+$/, ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      // Reject local/private addresses. This feature only reads public sites.
      if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(url.hostname)) continue;
      const gh = githubRepo(url);
      if (gh) {
        const api = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
        const metadata = JSON.parse(await getText(api, "application/vnd.github+json")) as Record<string, unknown>;
        const details = [
          `Repositório: ${gh.owner}/${gh.repo}`,
          `Descrição: ${String(metadata.description ?? "Sem descrição")}`,
          `Linguagem: ${String(metadata.language ?? "Não informada")}`,
          `Stars: ${String(metadata.stargazers_count ?? "?")}`,
          `Branch padrão: ${String(metadata.default_branch ?? "?")}`,
          `Atualizado: ${String(metadata.pushed_at ?? "?")}`,
          `Issues abertas: ${String(metadata.open_issues_count ?? "?")}`,
        ];
        try {
          const readme = await getText(`${api}/readme`, "application/vnd.github.raw+json");
          details.push(`README:\n${readme.slice(0, 9000)}`);
        } catch { /* README optional */ }
        snippets.push(`Fonte pública: ${url.toString()}\n${details.join("\n")}`);
      } else {
        // HTTP content is treated as untrusted data; never as instructions.
        const html = await getText(url.toString(), "text/html, text/plain");
        snippets.push(`Fonte pública: ${url.toString()}\n${plainHtml(html).slice(0, 8500)}`);
      }
    } catch (error) {
      snippets.push(`Não foi possível consultar ${raw}: ${String(error)}`);
    }
  }
  return snippets.join("\n\n").slice(0, MAX_CONTEXT);
};
