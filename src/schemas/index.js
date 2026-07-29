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
  // Structured resolution report (from the org's workflow config). All optional at
  // the schema level; the frontend enforces which are required per decision type.
  // false_alarm/false_positive -> resolution_category; genuine -> urgency +
  // notified + staff. ids are validated against the org config when applied.
  resolution_category: Joi.string().max(64).allow(null, ""),
  resolution_urgency: Joi.string().max(64).allow(null, ""),
  resolution_notified: Joi.array().items(Joi.string().max(64)),
  resolution_staff: Joi.array().items(Joi.string().max(128)),
});

// ---- sites --------------------------------------------------------------
export const addUserToSiteSchema = Joi.object({
  email: email.required(),
});

// ---- admin --------------------------------------------------------------
export const createOrganizationSchema = Joi.object({
  name: Joi.string().required(),
  // Flag the org as a test organisation (its data is hidden from a superadmin's
  // views unless they enable "view test organisation data").
  is_test: Joi.boolean().default(false),
});

// Superuser self-preference (PATCH /admin/preferences). Currently just the
// test-org visibility toggle; default false so test data is hidden by default.
export const preferencesSchema = Joi.object({
  show_test_data: Joi.boolean().required(),
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
  // When true, an operator may mark an alert genuine/false directly, bypassing
  // the two-person review (their single decision is final).
  allow_operator_direct_resolve: Joi.boolean(),
}).min(1);

// Superuser edit of ANY organisation (PATCH /admin/organizations/{id}): rename
// and/or change the footage policy. At least one field.
// Per-org incident-workflow config (superadmin-editable on /organisations/:id).
const workflowItem = Joi.object({
  id: Joi.string().max(64).required(),
  label: Joi.string().max(200).required(),
});
const urgencyItem = Joi.object({
  id: Joi.string().max(64).required(),
  label: Joi.string().max(200).required(),
  hint: Joi.string().max(300).allow("", null),
  severity: Joi.string().valid("critical", "management", "normal").required(),
});
export const workflowConfigSchema = Joi.object({
  categories: Joi.object({
    false_alarm: Joi.array().items(workflowItem),
    false_positive: Joi.array().items(workflowItem),
  }),
  urgency: Joi.array().items(urgencyItem),
  notified: Joi.array().items(workflowItem),
});

export const adminOrgUpdateSchema = Joi.object({
  name: Joi.string(),
  footage_sla_days: Joi.number().integer().min(1).max(14),
  require_restore_approval: Joi.boolean(),
  allow_operator_direct_resolve: Joi.boolean(),
  is_test: Joi.boolean(),
  workflow_config: workflowConfigSchema,
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

// Site-admin edit of an org user (PATCH /api/v1/users/{id}). At least one field;
// role capped to operator/site_admin (superuser impossible) and re-checked
// against the caller's rank in the handler. site_ids REPLACES the user's set.
export const orgUserUpdateSchema = Joi.object({
  full_name: Joi.string(),
  email,
  role: Joi.string().valid("operator", "site_admin"),
  site_ids: Joi.array().items(uuid),
}).min(1);

// Site-admin self-serve site creation (POST /api/v1/sites). Org comes from the
// caller's token (never the body). VMS-less: nx_host/username/password are NOT
// accepted here - those infra secrets are provisioned by a superuser later.
// site_token is optional; the handler auto-derives a unique slug from the name.
export const orgSiteCreateSchema = Joi.object({
  name: Joi.string().required(),
  // Superuser-only: target org. A site_admin's org comes from their token (ignored).
  organization_id: uuid,
  site_token: Joi.string()
    .min(2)
    .pattern(SITE_TOKEN)
    .messages({
      "string.pattern.base":
        "site_token must be at least 2 characters and contain only lowercase letters, numbers, and hyphens (no leading/trailing hyphens)",
    }),
  address: Joi.string().allow("", null),
  latitude: Joi.number().allow(null),
  longitude: Joi.number().allow(null),
});

// Site-admin edit of a site (PATCH /api/v1/sites/{id}). At least one field. Only
// name + address + coordinates - never nx_* secrets, site_token, or organization_id.
export const orgSiteUpdateSchema = Joi.object({
  name: Joi.string(),
  address: Joi.string().allow("", null),
  latitude: Joi.number().allow(null),
  longitude: Joi.number().allow(null),
}).min(1);
