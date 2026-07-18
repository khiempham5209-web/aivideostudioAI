import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
    };
  };
};

export type ProjectStatus = "draft" | "generating_script" | "rendering" | "completed" | "failed";
export type RenderJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ProjectRecord {
  id: string;
  owner_email: string;
  title: string;
  topic: string;
  status: ProjectStatus;
  voice_id: string;
  voice_name: string;
  voice_speed: number;
  output_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRecord {
  email: string;
  name: string;
  picture: string | null;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  email: string;
  expires_at: string;
  created_at: string;
}

export interface UserSettingsRecord {
  email: string;
  storage_quota_bytes: number;
  credits: number;
  default_language: string;
  default_ratio: string;
  default_quality: string;
  theme: string;
  ui_scale: number;
  storage_mode: string;
  save_root: string | null;
  created_at: string;
  updated_at: string;
}

export interface RenderJobRecord {
  id: string;
  project_id: string;
  status: RenderJobStatus;
  progress: number;
  current_step: string;
  output_dir: string | null;
  script_path: string | null;
  video_path: string | null;
  audio_path: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetRecord {
  id: string;
  project_id: string;
  type: "video" | "audio" | "image" | "other";
  file_name: string;
  mime_type: string;
  file_path: string;
  file_size: number;
  duration: number | null;
  created_at: string;
}

export interface SceneRecord {
  id: string;
  project_id: string;
  scene_key: string;
  scene_order: number;
  scene_type: string;
  voice_text: string;
  template_id: string;
  source_asset_id: string | null;
  source_start: number | null;
  source_end: number | null;
  created_at: string;
  updated_at: string;
}

const DB_PATH = resolve("data", "app.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL DEFAULT 'local@device',
    title TEXT NOT NULL,
    topic TEXT NOT NULL,
    status TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    voice_name TEXT NOT NULL,
    voice_speed REAL NOT NULL,
    output_path TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    picture TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(email) REFERENCES users(email)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    email TEXT PRIMARY KEY,
    storage_quota_bytes INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    default_language TEXT NOT NULL,
    default_ratio TEXT NOT NULL,
    default_quality TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'dark',
    ui_scale REAL NOT NULL DEFAULT 1,
    storage_mode TEXT NOT NULL DEFAULT 'server',
    save_root TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(email) REFERENCES users(email)
  );

  CREATE TABLE IF NOT EXISTS render_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    current_step TEXT NOT NULL,
    output_dir TEXT,
    script_path TEXT,
    video_path TEXT,
    audio_path TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scene_key TEXT NOT NULL,
    scene_order INTEGER NOT NULL,
    scene_type TEXT NOT NULL,
    voice_text TEXT NOT NULL,
    template_id TEXT NOT NULL,
    source_asset_id TEXT,
    source_start REAL,
    source_end REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );
`);

for (const statement of [
  "ALTER TABLE projects ADD COLUMN owner_email TEXT NOT NULL DEFAULT 'local@device'",
  "ALTER TABLE user_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'",
  "ALTER TABLE user_settings ADD COLUMN ui_scale REAL NOT NULL DEFAULT 1",
  "ALTER TABLE user_settings ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'server'",
  "ALTER TABLE user_settings ADD COLUMN save_root TEXT",
]) {
  try {
    db.exec(statement);
  } catch {
    // Column already exists on upgraded databases.
  }
}

type DbRow = Record<string, string | number | null>;

const DATABASE_URL = process.env.DATABASE_URL;
const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;
let pgWriteQueue: Promise<void> = Promise.resolve();

async function initPostgresMirror() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL DEFAULT 'local@device',
      title TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      voice_name TEXT NOT NULL,
      voice_speed DOUBLE PRECISION NOT NULL,
      output_path TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      picture TEXT,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
      storage_quota_bytes BIGINT NOT NULL,
      credits INTEGER NOT NULL,
      default_language TEXT NOT NULL,
      default_ratio TEXT NOT NULL,
      default_quality TEXT NOT NULL,
      theme TEXT NOT NULL DEFAULT 'dark',
      ui_scale DOUBLE PRECISION NOT NULL DEFAULT 1,
      storage_mode TEXT NOT NULL DEFAULT 'server',
      save_root TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS render_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      current_step TEXT NOT NULL,
      output_dir TEXT,
      script_path TEXT,
      video_path TEXT,
      audio_path TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size BIGINT NOT NULL,
      duration DOUBLE PRECISION,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scene_key TEXT NOT NULL,
      scene_order INTEGER NOT NULL,
      scene_type TEXT NOT NULL,
      voice_text TEXT NOT NULL,
      template_id TEXT NOT NULL,
      source_asset_id TEXT,
      source_start DOUBLE PRECISION,
      source_end DOUBLE PRECISION,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner_email ON projects(owner_email);
    CREATE INDEX IF NOT EXISTS idx_render_jobs_project_id ON render_jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id);
    CREATE INDEX IF NOT EXISTS idx_scenes_project_id_order ON scenes(project_id, scene_order);
  `);
}

async function pgExec(sql: string, params: unknown[] = []) {
  if (!pgPool) return;
  pgWriteQueue = pgWriteQueue
    .then(() => pgPool.query(sql, params).then(() => undefined))
    .catch((error) => {
      console.warn("Postgres mirror write failed:", error instanceof Error ? error.message : error);
    });
  await pgWriteQueue;
}

function mirrorUpsert(table: string, row: DbRow, conflictKey: string) {
  const cols = Object.keys(row);
  const params = cols.map((col) => row[col]);
  const placeholders = cols.map((_, index) => `$${index + 1}`).join(", ");
  const updates = cols.filter((col) => col !== conflictKey).map((col) => `${col} = EXCLUDED.${col}`).join(", ");
  void pgExec(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${conflictKey}) DO UPDATE SET ${updates}`,
    params,
  );
}

async function loadPostgresIntoSqlite() {
  if (!pgPool) return;
  await initPostgresMirror();
  const tables = ["users", "user_settings", "projects", "render_jobs", "assets", "scenes", "sessions"] as const;
  const rows = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await pgPool.query(`SELECT * FROM ${table}`)).rows]))) as Record<
    (typeof tables)[number],
    DbRow[]
  >;
  db.exec("DELETE FROM sessions; DELETE FROM user_settings; DELETE FROM scenes; DELETE FROM assets; DELETE FROM render_jobs; DELETE FROM projects; DELETE FROM users;");
  const insertRows = (table: string, items: DbRow[]) => {
    for (const row of items) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => "?").join(", ");
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...cols.map((col) => row[col]));
    }
  };
  insertRows("users", rows.users);
  insertRows("user_settings", rows.user_settings);
  insertRows("projects", rows.projects);
  insertRows("render_jobs", rows.render_jobs);
  insertRows("assets", rows.assets);
  insertRows("scenes", rows.scenes);
  insertRows("sessions", rows.sessions);
  console.log(`Postgres metadata mirror enabled (${rows.projects.length} projects loaded).`);
}

await loadPostgresIntoSqlite();

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createProject(data: {
  ownerEmail: string;
  topic: string;
  voiceId: string;
  voiceName: string;
  voiceSpeed: number;
}): ProjectRecord {
  const created = nowIso();
  const project: ProjectRecord = {
    id: id("proj"),
    owner_email: data.ownerEmail,
    title: "Untitled video",
    topic: data.topic,
    status: "draft",
    voice_id: data.voiceId,
    voice_name: data.voiceName,
    voice_speed: data.voiceSpeed,
    output_path: null,
    error_message: null,
    created_at: created,
    updated_at: created,
  };
  db.prepare(`
    INSERT INTO projects
    (id, owner_email, title, topic, status, voice_id, voice_name, voice_speed, output_path, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.owner_email,
    project.title,
    project.topic,
    project.status,
    project.voice_id,
    project.voice_name,
    project.voice_speed,
    project.output_path,
    project.error_message,
    project.created_at,
    project.updated_at,
  );
  mirrorUpsert("projects", project as unknown as DbRow, "id");
  return project;
}

export function createRenderJob(projectId: string): RenderJobRecord {
  const created = nowIso();
  const job: RenderJobRecord = {
    id: id("job"),
    project_id: projectId,
    status: "queued",
    progress: 0,
    current_step: "Queued",
    output_dir: null,
    script_path: null,
    video_path: null,
    audio_path: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: created,
    updated_at: created,
  };
  db.prepare(`
    INSERT INTO render_jobs
    (id, project_id, status, progress, current_step, output_dir, script_path, video_path, audio_path, error_message, started_at, finished_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.project_id,
    job.status,
    job.progress,
    job.current_step,
    job.output_dir,
    job.script_path,
    job.video_path,
    job.audio_path,
    job.error_message,
    job.started_at,
    job.finished_at,
    job.created_at,
    job.updated_at,
  );
  mirrorUpsert("render_jobs", job as unknown as DbRow, "id");
  return job;
}

export function listProjects(ownerEmail: string): ProjectRecord[] {
  return db.prepare("SELECT * FROM projects WHERE owner_email = ? ORDER BY created_at DESC LIMIT 50").all(ownerEmail) as ProjectRecord[];
}

export function getProject(projectId: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRecord | undefined;
}

export function getUserProject(ownerEmail: string, projectId: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ? AND owner_email = ?").get(projectId, ownerEmail) as ProjectRecord | undefined;
}

export function getLatestJobForProject(projectId: string): RenderJobRecord | undefined {
  return db
    .prepare("SELECT * FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(projectId) as RenderJobRecord | undefined;
}

export function getRenderJob(jobId: string): RenderJobRecord | undefined {
  return db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(jobId) as RenderJobRecord | undefined;
}

export function createAsset(data: {
  projectId: string;
  type: AssetRecord["type"];
  fileName: string;
  mimeType: string;
  filePath: string;
  fileSize: number;
  duration?: number | null;
}): AssetRecord {
  const asset: AssetRecord = {
    id: id("asset"),
    project_id: data.projectId,
    type: data.type,
    file_name: data.fileName,
    mime_type: data.mimeType,
    file_path: data.filePath,
    file_size: data.fileSize,
    duration: data.duration ?? null,
    created_at: nowIso(),
  };
  db.prepare(`
    INSERT INTO assets
    (id, project_id, type, file_name, mime_type, file_path, file_size, duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset.id,
    asset.project_id,
    asset.type,
    asset.file_name,
    asset.mime_type,
    asset.file_path,
    asset.file_size,
    asset.duration,
    asset.created_at,
  );
  mirrorUpsert("assets", asset as unknown as DbRow, "id");
  return asset;
}

export function listAssets(projectId: string): AssetRecord[] {
  return db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as AssetRecord[];
}

export function getAsset(assetId: string): AssetRecord | undefined {
  return db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRecord | undefined;
}

export function deleteAsset(assetId: string): AssetRecord | undefined {
  const asset = getAsset(assetId);
  if (!asset) return undefined;
  db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
  db.prepare("UPDATE scenes SET source_asset_id = NULL WHERE source_asset_id = ?").run(assetId);
  void pgExec("DELETE FROM assets WHERE id = $1", [assetId]);
  void pgExec("UPDATE scenes SET source_asset_id = NULL WHERE source_asset_id = $1", [assetId]);
  return asset;
}

export function replaceProjectScenes(
  projectId: string,
  scenes: Array<{ id: string; type: string; voiceText: string; templateId: string }>,
): SceneRecord[] {
  const created = nowIso();
  db.prepare("DELETE FROM scenes WHERE project_id = ?").run(projectId);
  void pgExec("DELETE FROM scenes WHERE project_id = $1", [projectId]);
  const insert = db.prepare(`
    INSERT INTO scenes
    (id, project_id, scene_key, scene_order, scene_type, voice_text, template_id, source_asset_id, source_start, source_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = scenes.map((scene, index) => {
    const row: SceneRecord = {
      id: id("scene"),
      project_id: projectId,
      scene_key: scene.id,
      scene_order: index,
      scene_type: scene.type,
      voice_text: scene.voiceText,
      template_id: scene.templateId,
      source_asset_id: null,
      source_start: null,
      source_end: null,
      created_at: created,
      updated_at: created,
    };
    insert.run(
      row.id,
      row.project_id,
      row.scene_key,
      row.scene_order,
      row.scene_type,
      row.voice_text,
      row.template_id,
      row.source_asset_id,
      row.source_start,
      row.source_end,
      row.created_at,
      row.updated_at,
    );
    mirrorUpsert("scenes", row as unknown as DbRow, "id");
    return row;
  });
  return rows;
}

export function addProjectScene(projectId: string, data: { voiceText: string; sceneType?: string; templateId?: string }): SceneRecord {
  const created = nowIso();
  const orderRow = db.prepare("SELECT COALESCE(MAX(scene_order), -1) + 1 AS next_order FROM scenes WHERE project_id = ?").get(projectId) as { next_order: number };
  const row: SceneRecord = {
    id: id("scene"),
    project_id: projectId,
    scene_key: id("manual"),
    scene_order: orderRow.next_order,
    scene_type: data.sceneType ?? "manual",
    voice_text: data.voiceText,
    template_id: data.templateId ?? "manual_scene",
    source_asset_id: null,
    source_start: null,
    source_end: null,
    created_at: created,
    updated_at: created,
  };
  db.prepare(`
    INSERT INTO scenes
    (id, project_id, scene_key, scene_order, scene_type, voice_text, template_id, source_asset_id, source_start, source_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.project_id,
    row.scene_key,
    row.scene_order,
    row.scene_type,
    row.voice_text,
    row.template_id,
    row.source_asset_id,
    row.source_start,
    row.source_end,
    row.created_at,
    row.updated_at,
  );
  mirrorUpsert("scenes", row as unknown as DbRow, "id");
  return row;
}

export function listScenes(projectId: string): SceneRecord[] {
  return db.prepare("SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order ASC").all(projectId) as SceneRecord[];
}

export function getScene(sceneId: string): SceneRecord | undefined {
  return db.prepare("SELECT * FROM scenes WHERE id = ?").get(sceneId) as SceneRecord | undefined;
}

export function updateScene(sceneId: string, data: Partial<Pick<SceneRecord, "voice_text" | "source_asset_id" | "source_start" | "source_end">>): SceneRecord | undefined {
  const current = getScene(sceneId);
  if (!current) return undefined;
  db.prepare(`
    UPDATE scenes
    SET voice_text = ?, source_asset_id = ?, source_start = ?, source_end = ?, updated_at = ?
    WHERE id = ?
  `).run(
    data.voice_text ?? current.voice_text,
    data.source_asset_id ?? current.source_asset_id,
    data.source_start ?? current.source_start,
    data.source_end ?? current.source_end,
    nowIso(),
    sceneId,
  );
  const updated = db.prepare("SELECT * FROM scenes WHERE id = ?").get(sceneId) as SceneRecord | undefined;
  if (updated) mirrorUpsert("scenes", updated as unknown as DbRow, "id");
  return updated;
}

export function deleteScene(sceneId: string): SceneRecord | undefined {
  const current = db.prepare("SELECT * FROM scenes WHERE id = ?").get(sceneId) as SceneRecord | undefined;
  if (!current) return undefined;
  db.prepare("DELETE FROM scenes WHERE id = ?").run(sceneId);
  void pgExec("DELETE FROM scenes WHERE id = $1", [sceneId]);
  const rows = db.prepare("SELECT id FROM scenes WHERE project_id = ? ORDER BY scene_order ASC").all(current.project_id) as Array<{ id: string }>;
  rows.forEach((row, index) => {
    db.prepare("UPDATE scenes SET scene_order = ?, updated_at = ? WHERE id = ?").run(index, nowIso(), row.id);
    const updated = getScene(row.id);
    if (updated) mirrorUpsert("scenes", updated as unknown as DbRow, "id");
  });
  return current;
}

export function moveScene(sceneId: string, direction: "up" | "down"): SceneRecord | undefined {
  const current = getScene(sceneId);
  if (!current) return undefined;
  const target = db.prepare(`
    SELECT * FROM scenes
    WHERE project_id = ? AND scene_order ${direction === "up" ? "<" : ">"} ?
    ORDER BY scene_order ${direction === "up" ? "DESC" : "ASC"}
    LIMIT 1
  `).get(current.project_id, current.scene_order) as SceneRecord | undefined;
  if (!target) return current;
  const updated = nowIso();
  db.prepare("UPDATE scenes SET scene_order = ?, updated_at = ? WHERE id = ?").run(target.scene_order, updated, current.id);
  db.prepare("UPDATE scenes SET scene_order = ?, updated_at = ? WHERE id = ?").run(current.scene_order, updated, target.id);
  const currentUpdated = getScene(current.id);
  const targetUpdated = getScene(target.id);
  if (currentUpdated) mirrorUpsert("scenes", currentUpdated as unknown as DbRow, "id");
  if (targetUpdated) mirrorUpsert("scenes", targetUpdated as unknown as DbRow, "id");
  return currentUpdated;
}

export function updateProject(projectId: string, data: Partial<Pick<ProjectRecord, "title" | "topic" | "status" | "voice_id" | "voice_name" | "voice_speed" | "output_path" | "error_message">>) {
  const current = getProject(projectId);
  if (!current) return;
  db.prepare(`
    UPDATE projects
    SET title = ?, topic = ?, status = ?, voice_id = ?, voice_name = ?, voice_speed = ?, output_path = ?, error_message = ?, updated_at = ?
    WHERE id = ?
  `).run(
    data.title ?? current.title,
    data.topic ?? current.topic,
    data.status ?? current.status,
    data.voice_id ?? current.voice_id,
    data.voice_name ?? current.voice_name,
    data.voice_speed ?? current.voice_speed,
    data.output_path ?? current.output_path,
    data.error_message ?? current.error_message,
    nowIso(),
    projectId,
  );
  const updated = getProject(projectId);
  if (updated) mirrorUpsert("projects", updated as unknown as DbRow, "id");
}

export function updateRenderJob(jobId: string, data: Partial<Omit<RenderJobRecord, "id" | "project_id" | "created_at" | "updated_at">>) {
  const current = getRenderJob(jobId);
  if (!current) return;
  db.prepare(`
    UPDATE render_jobs
    SET status = ?, progress = ?, current_step = ?, output_dir = ?, script_path = ?, video_path = ?, audio_path = ?,
        error_message = ?, started_at = ?, finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    data.status ?? current.status,
    data.progress ?? current.progress,
    data.current_step ?? current.current_step,
    data.output_dir ?? current.output_dir,
    data.script_path ?? current.script_path,
    data.video_path ?? current.video_path,
    data.audio_path ?? current.audio_path,
    data.error_message ?? current.error_message,
    data.started_at ?? current.started_at,
    data.finished_at ?? current.finished_at,
    nowIso(),
    jobId,
  );
  const updated = getRenderJob(jobId);
  if (updated) mirrorUpsert("render_jobs", updated as unknown as DbRow, "id");
}

export function upsertUser(data: { email: string; name: string; picture?: string | null; provider: string }): UserRecord {
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(data.email) as UserRecord | undefined;
  const timestamp = nowIso();
  if (existing) {
    db.prepare("UPDATE users SET name = ?, picture = ?, provider = ?, updated_at = ? WHERE email = ?").run(
      data.name,
      data.picture ?? null,
      data.provider,
      timestamp,
      data.email,
    );
  } else {
    db.prepare("INSERT INTO users (email, name, picture, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      data.email,
      data.name,
      data.picture ?? null,
      data.provider,
      timestamp,
      timestamp,
    );
  }
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(data.email) as UserRecord;
  mirrorUpsert("users", user as unknown as DbRow, "email");
  return user;
}

export function createSession(email: string, ttlDays = 30): SessionRecord {
  const created = nowIso();
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const session: SessionRecord = {
    id: id("sess"),
    email,
    expires_at: expires,
    created_at: created,
  };
  db.prepare("INSERT INTO sessions (id, email, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    session.id,
    session.email,
    session.expires_at,
    session.created_at,
  );
  mirrorUpsert("sessions", session as unknown as DbRow, "id");
  return session;
}

export function getSession(sessionId: string): (SessionRecord & { name: string; picture: string | null }) | undefined {
  const session = db.prepare(`
    SELECT sessions.*, users.name, users.picture
    FROM sessions
    JOIN users ON users.email = sessions.email
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(sessionId, nowIso()) as (SessionRecord & { name: string; picture: string | null }) | undefined;
  return session;
}

export function deleteSession(sessionId: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  void pgExec("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export function getStats(ownerEmail: string) {
  const projectRows = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('generating_script', 'rendering') THEN 1 ELSE 0 END) AS rendering
    FROM projects
    WHERE owner_email = ?
  `).get(ownerEmail) as { total: number; completed: number | null; rendering: number | null };
  const exportRows = db.prepare(`
    SELECT COUNT(*) AS exports
    FROM render_jobs
    JOIN projects ON projects.id = render_jobs.project_id
    WHERE projects.owner_email = ? AND render_jobs.status = 'completed'
  `).get(ownerEmail) as { exports: number };
  const assetRows = db.prepare(`
    SELECT COALESCE(SUM(file_size), 0) AS asset_bytes
    FROM assets
    JOIN projects ON projects.id = assets.project_id
    WHERE projects.owner_email = ?
  `).get(ownerEmail) as { asset_bytes: number };
  return {
    totalVideos: projectRows.total ?? 0,
    completedVideos: projectRows.completed ?? 0,
    renderingVideos: projectRows.rendering ?? 0,
    exports: exportRows.exports ?? 0,
    assetBytes: assetRows.asset_bytes ?? 0,
  };
}

export function isUserFile(ownerEmail: string, filePath: string): boolean {
  const asset = db.prepare(`
    SELECT assets.id
    FROM assets
    JOIN projects ON projects.id = assets.project_id
    WHERE projects.owner_email = ? AND assets.file_path = ?
    LIMIT 1
  `).get(ownerEmail, filePath);
  if (asset) return true;

  const job = db.prepare(`
    SELECT render_jobs.id
    FROM render_jobs
    JOIN projects ON projects.id = render_jobs.project_id
    WHERE projects.owner_email = ?
      AND (
        render_jobs.video_path = ?
        OR render_jobs.audio_path = ?
        OR render_jobs.script_path = ?
        OR (? LIKE render_jobs.output_dir || '%')
      )
    LIMIT 1
  `).get(ownerEmail, filePath, filePath, filePath, filePath);
  return Boolean(job);
}

export function listUserStoragePaths(ownerEmail: string): string[] {
  const assetRows = db.prepare(`
    SELECT assets.file_path AS path
    FROM assets
    JOIN projects ON projects.id = assets.project_id
    WHERE projects.owner_email = ?
  `).all(ownerEmail) as Array<{ path: string }>;
  const jobRows = db.prepare(`
    SELECT render_jobs.output_dir AS path
    FROM render_jobs
    JOIN projects ON projects.id = render_jobs.project_id
    WHERE projects.owner_email = ? AND render_jobs.output_dir IS NOT NULL
  `).all(ownerEmail) as Array<{ path: string }>;
  return [...assetRows, ...jobRows].map((row) => row.path).filter(Boolean);
}

export function getUserSettings(email: string): UserSettingsRecord {
  const existing = db.prepare("SELECT * FROM user_settings WHERE email = ?").get(email) as UserSettingsRecord | undefined;
  if (existing) return existing;
  const created = nowIso();
  db.prepare(`
    INSERT INTO user_settings
    (email, storage_quota_bytes, credits, default_language, default_ratio, default_quality, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(email, 50 * 1024 * 1024 * 1024, 0, "Tiếng Việt", "9:16", "1080p", created, created);
  const settings = db.prepare("SELECT * FROM user_settings WHERE email = ?").get(email) as UserSettingsRecord;
  mirrorUpsert("user_settings", settings as unknown as DbRow, "email");
  return settings;
}

export function updateUserSettings(
  email: string,
  data: Partial<Pick<UserSettingsRecord, "storage_quota_bytes" | "credits" | "default_language" | "default_ratio" | "default_quality" | "theme" | "ui_scale" | "storage_mode" | "save_root">>,
): UserSettingsRecord {
  const current = getUserSettings(email);
  db.prepare(`
    UPDATE user_settings
    SET storage_quota_bytes = ?, credits = ?, default_language = ?, default_ratio = ?, default_quality = ?, theme = ?, ui_scale = ?, storage_mode = ?, save_root = ?, updated_at = ?
    WHERE email = ?
  `).run(
    data.storage_quota_bytes ?? current.storage_quota_bytes,
    data.credits ?? current.credits,
    data.default_language ?? current.default_language,
    data.default_ratio ?? current.default_ratio,
    data.default_quality ?? current.default_quality,
    data.theme ?? current.theme,
    data.ui_scale ?? current.ui_scale,
    data.storage_mode ?? current.storage_mode,
    data.save_root === undefined ? current.save_root : data.save_root,
    nowIso(),
    email,
  );
  const updated = getUserSettings(email);
  mirrorUpsert("user_settings", updated as unknown as DbRow, "email");
  return updated;
}

export { DB_PATH };
