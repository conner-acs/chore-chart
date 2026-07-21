import Joi from "joi";

// Joi schemas mirroring the FastAPI/Pydantic request models. Used by the
// middleware to validate + coerce JSON bodies (422 on failure, matching
// FastAPI's validation error status).

export const ROLES = ["operator", "site_admin", "superuser"];

// Decision targets — unprocessed is not a valid decision (see app/schemas/alert.py).
const DECISION_STATUSES = ["discarded", "submitted_for_review", "incident"];

// Nx Witness camera IDs: UUID, optionally brace-wrapped.
const NX_CAMERA_ID = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const ALERT_TYPE = /^[a-zA-Z0-9_-]{1,100}$/;
// site_token: >=2 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen.
const SITE_TOKEN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const uuid = Joi.string().uuid();
const email = Joi.string().email();

// ---- auth ---------------------------------------------------------------
export const loginSchema = Joi.object({
  email: email.required(),
  password: Joi.string().required(),
});

export const refreshSchema = Joi.object({
  refresh_token: Joi.string().required(),
});

export const forgotPasswordSchema = Joi.object({
  email: email.required(),
}).options({ stripUnknown: true });

// Settings "Send test alert" — all fields optional; the handler fills defaults.
export const testAlertSchema = Joi.object({
  site_id: Joi.string().uuid(),
  camera_id: Joi.string(),
  alert_type: Joi.string().pattern(ALERT_TYPE),
}).options({ stripUnknown: true });

export const setPasswordSchema = Joi.object({
  token: Joi.string().required(),
  new_password: Joi.string().min(8).required(),
});

// ---- alerts -------------------------------------------------------------
export const webhookAlertSchema = Joi.object({
  site_token: Joi.string().required(),
  camera_id: Joi.string().pattern(NX_CAMERA_ID).required().messages({
    "string.pattern.base": "camera_id must be a valid Nx Witness camera UUID",
  }),
  alert_type: Joi.string().pattern(ALERT_TYPE).required().messages({
    "string.pattern.base":
      "alert_type must be 1-100 alphanumeric, underscore, or hyphen characters",
  }),
  start_timestamp: Joi.date().iso().required(),
  end_timestamp: Joi.date().iso().required(),
  nx_bookmark_id: Joi.string().allow(null),
});

// Decision labels (the workflow unit). Terminal status is derived from these
// server-side: genuine -> incident, false_alarm/false_positive -> discarded.
export const DECISION_LABELS = ["false_alarm", "false_positive", "genuine"];

export const alertDecisionSchema = Joi.object({
  // status="submitted_for_review" means escalate/propose; incident|discarded
  // means a resolution attempt (the terminal status is re-derived from the label).
  status: Joi.string().valid(...DECISION_STATUSES).required().messages({
    "any.only": "status must be 'discarded', 'submitted_for_review', or 'incident'",
  }),
  // The proposed/agreed/resolved label — always required.
  decision_label: Joi.string().valid(...DECISION_LABELS).required().messages({
    "any.only": "decision_label must be 'false_alarm', 'false_positive', or 'genuine'",
  }),
  // Optional free-text note (e.g. a dissent reason); persisted as review_note.
  note: Joi.string().allow(null, ""),
});

// ---- sites --------------------------------------------------------------
export const addUserToSiteSchema = Joi.object({
  email: email.required(),
});

// ---- admin --------------------------------------------------------------
export const createOrganizationSchema = Joi.object({
  name: Joi.string().required(),
});

const siteFields = {
  name: Joi.string().required(),
  site_token: Joi.string().min(2).pattern(SITE_TOKEN).required().messages({
    "string.pattern.base":
      "site_token must be at least 2 characters and contain only lowercase letters, numbers, and hyphens (no leading/trailing hyphens)",
  }),
  nx_host: Joi.string().required(),
  nx_username: Joi.string().required(),
  nx_password: Joi.string().required(),
  nx_tls_cert: Joi.string().allow(null),
  latitude: Joi.number().allow(null),
  longitude: Joi.number().allow(null),
};

// POST /admin/sites — organization in the body.
export const createSiteSchema = Joi.object({
  ...siteFields,
  organization_id: uuid.required(),
});

// POST /admin/organizations/{id}/sites — org comes from the URL path.
export const createSiteInOrgSchema = Joi.object(siteFields);

export const createUserSchema = Joi.object({
  email: email.required(),
  password: Joi.string().required(),
  full_name: Joi.string().required(),
  phone: Joi.string().max(32).allow("", null),
  role: Joi.string().valid(...ROLES).required(),
  organization_id: uuid.required(),
  site_ids: Joi.array().items(uuid).default([]),
});

export const updateUserSchema = Joi.object({
  id: uuid.required(),
  email: email,
  password: Joi.string(),
  full_name: Joi.string(),
  phone: Joi.string().max(32).allow("", null),
  role: Joi.string().valid(...ROLES),
  organization_id: uuid,
  site_ids: Joi.array().items(uuid),
});

// Per-org footage policy (site_admin-editable). PATCH semantics: at least one
// field, each optional. footage_sla_days is clamped to the SLA range; see
// lib/sla.js (MIN_SLA_DAYS..MAX_SLA_DAYS).
export const orgSettingsSchema = Joi.object({
  footage_sla_days: Joi.number().integer().min(1).max(14),
  require_restore_approval: Joi.boolean(),
}).min(1);

// Optional free-text note on a retrieve request or an approve/deny decision.
// All-optional so an empty POST body ({}) validates.
export const optionalNoteSchema = Joi.object({
  note: Joi.string().max(500).allow("", null),
});

// Site-admin self-service user creation (POST /api/v1/users). The org is taken
// from the caller's token (never a param); role is capped to operator/site_admin
// at the schema (superuser is impossible here) and re-checked against the
// caller's rank in the handler. No password - onboarding is invite-based.
export const orgUserCreateSchema = Joi.object({
  email: email.required(),
  full_name: Joi.string().required(),
  phone: Joi.string().max(32).allow("", null),
  role: Joi.string().valid("operator", "site_admin").required(),
  site_ids: Joi.array().items(uuid).default([]),
});
