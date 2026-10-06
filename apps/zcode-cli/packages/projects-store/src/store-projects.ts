import {
  NON_TERMINAL_MISSION_STATUSES,
  type Mission,
  type MissionId,
  type MissionPatch,
  type Project,
  type ProjectId,
  type ProjectStatus,
} from "./domain.js";
import { conflict, notFound } from "./errors.js";
import { encodeJson } from "./json.js";
import { mapMission, mapProject, type MissionRow, type ProjectRow } from "./rows.js";
import { buildUpdate, placeholders, type PatchField } from "./sql.js";
import { ProjectsStoreBase } from "./store-base.js";

const PROJECT_COLUMNS = "id, name, repository_path, default_branch, status, created_at";
const MISSION_COLUMNS =
  "id, project_id, title, objective, source_json, status, phase, run_id, plan_version, created_at, started_at, completed_at, summary, block_reason";

const MISSION_PATCH: Readonly<Record<string, PatchField>> = {
  title: { column: "title" },
  objective: { column: "objective" },
  source: { column: "source_json", encode: (value) => encodeJson(value, "mission.source") },
  status: { column: "status" },
  phase: { column: "phase" },
  runId: { column: "run_id" },
  planVersion: { column: "plan_version" },
  startedAt: { column: "started_at" },
  completedAt: { column: "completed_at" },
  summary: { column: "summary" },
  blockReason: { column: "block_reason" },
};

/** Project registry and mission lifecycle (mission truth lives here, decision D5). */
export interface ProjectsApi {
  createProject(project: Project): Project;
  getProject(id: ProjectId): Project | undefined;
  listProjects(): Project[];
  updateProjectStatus(id: ProjectId, status: ProjectStatus): Project;
  createMission(mission: Mission): Mission;
  getMission(id: MissionId): Mission | undefined;
  listMissionsByProject(projectId: ProjectId): Mission[];
  listActiveMissions(): Mission[];
  recoverableMissionIds(): MissionId[];
  updateMission(id: MissionId, patch: MissionPatch): Mission;
}

export class ProjectMethods extends ProjectsStoreBase implements ProjectsApi {
  createProject(project: Project): Project {
    if (this.getProject(project.id)) throw conflict("project", project.id);
    this.execute(
      "INSERT INTO projects(id, name, repository_path, default_branch, status, created_at) VALUES(?,?,?,?,?,?)",
      project.id,
      project.name,
      project.repositoryPath,
      project.defaultBranch,
      project.status,
      project.createdAt,
    );
    return this.requireProject(project.id);
  }

  getProject(id: ProjectId): Project | undefined {
    const row = this.queryOne<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
      id,
    );
    return row ? mapProject(row) : undefined;
  }

  listProjects(): Project[] {
    return this.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at ASC, id ASC`,
    ).map(mapProject);
  }

  updateProjectStatus(id: ProjectId, status: ProjectStatus): Project {
    this.execute("UPDATE projects SET status = ? WHERE id = ?", status, id);
    return this.requireProject(id);
  }

  createMission(mission: Mission): Mission {
    if (this.getMission(mission.id)) throw conflict("mission", mission.id);
    this.execute(
      `INSERT INTO missions(${MISSION_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      mission.id,
      mission.projectId,
      mission.title,
      mission.objective,
      encodeJson(mission.source, "mission.source"),
      mission.status,
      mission.phase,
      mission.runId ?? null,
      mission.planVersion ?? null,
      mission.createdAt,
      mission.startedAt ?? null,
      mission.completedAt ?? null,
      mission.summary ?? null,
      mission.blockReason ?? null,
    );
    return this.requireMission(mission.id);
  }

  getMission(id: MissionId): Mission | undefined {
    const row = this.queryOne<MissionRow>(
      `SELECT ${MISSION_COLUMNS} FROM missions WHERE id = ?`,
      id,
    );
    return row ? mapMission(row) : undefined;
  }

  /** Missions of one project, newest first. */
  listMissionsByProject(projectId: ProjectId): Mission[] {
    return this.query<MissionRow>(
      `SELECT ${MISSION_COLUMNS} FROM missions WHERE project_id = ? ORDER BY created_at DESC, id ASC`,
      projectId,
    ).map(mapMission);
  }

  /** Missions in a non-terminal status, oldest first: the restart-recovery worklist. */
  listActiveMissions(): Mission[] {
    return this.query<MissionRow>(
      `SELECT ${MISSION_COLUMNS} FROM missions WHERE status IN (${placeholders(NON_TERMINAL_MISSION_STATUSES.length)}) ORDER BY created_at ASC, id ASC`,
      ...NON_TERMINAL_MISSION_STATUSES,
    ).map(mapMission);
  }

  recoverableMissionIds(): MissionId[] {
    return this.query<{ id: string }>(
      `SELECT id FROM missions WHERE status IN (${placeholders(NON_TERMINAL_MISSION_STATUSES.length)}) ORDER BY created_at ASC, id ASC`,
      ...NON_TERMINAL_MISSION_STATUSES,
    ).map((row) => row.id);
  }

  /** Applies a patch and returns the stored mission; unknown patch fields are rejected. */
  updateMission(id: MissionId, patch: MissionPatch): Mission {
    const update = buildUpdate("missions", MISSION_PATCH, patch);
    if (update) this.execute(update.sql, ...update.values, id);
    return this.requireMission(id);
  }

  protected requireProject(id: ProjectId): Project {
    const project = this.getProject(id);
    if (!project) throw notFound("project", id);
    return project;
  }

  protected requireMission(id: MissionId): Mission {
    const mission = this.getMission(id);
    if (!mission) throw notFound("mission", id);
    return mission;
  }
}
