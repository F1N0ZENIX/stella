import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

const KEY = "stella_groq_api_key_v1";
const DB = "stella_groq_local.db";
export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
export type GroqModel = { id: string; active?: boolean };

export async function setGroqKey(value: string): Promise<void> {
  if (!value.trim()) { await SecureStore.deleteItemAsync(KEY); return; }
  await SecureStore.setItemAsync(KEY, value.trim());
}
export function getGroqKey(): Promise<string | null> { return SecureStore.getItemAsync(KEY); }

async function requestGroq(path: string, init?: RequestInit): Promise<any> {
  const key = await getGroqKey();
  if (!key) throw new Error("Configure sua chave Groq nas configurações.");
  const response = await fetch("https://api.groq.com/openai/v1/" + path, {
    ...init,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error("Groq HTTP " + response.status + ": " + (body?.error?.message ?? "Falha na solicitação"));
  return body;
}
export async function listGroqModels(): Promise<GroqModel[]> {
  const body = await requestGroq("models");
  return Array.isArray(body.data) ? body.data.filter((item: GroqModel) => typeof item.id === "string") : [];
}
export async function askGroq(messages: ChatMessage[], preference: string = "automatico"): Promise<{ text: string; model: string }> {
  const models = await listGroqModels();
  const available = new Set(models.map(m => m.id));
  const last = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  const complex = last.length > 450 || /analise|compare|planeje|código|detalhadamente/i.test(last);
  const priority = complex
    ? ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]
    : ["llama-3.1-8b-instant", "openai/gpt-oss-20b", "openai/gpt-oss-120b"];
  const candidates = preference === "automatico" ? priority.filter(id => available.has(id)) : [preference].filter(id => available.has(id));
  if (!candidates.length) throw new Error("Nenhum modelo compatível disponível para esta chave Groq.");
  let lastError: unknown;
  for (const model of candidates) {
    try {
      const result = await requestGroq("chat/completions", {
        method: "POST",
        body: JSON.stringify({ model, messages, stream: false }),
      });
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("Resposta sem texto do modelo " + model);
      return { text, model };
    } catch (error) {
      lastError = error;
      if (!/Groq HTTP (404|429|500|502|503)/.test(String(error))) throw error;
    }
  }
  throw lastError ?? new Error("Modelos indisponíveis");
}
export async function openLocalGroqDb() {
  const db = await SQLite.openDatabaseAsync(DB);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);`);
  return db;
}
export async function saveLocalMessage(conversationId: string, role: "user" | "assistant", content: string) {
  const db = await openLocalGroqDb();
  await db.runAsync("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)", conversationId, role, content, new Date().toISOString());
}
export async function loadLocalMessages(conversationId: string): Promise<ChatMessage[]> {
  const db = await openLocalGroqDb();
  return db.getAllAsync<ChatMessage>("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC", conversationId);
}
