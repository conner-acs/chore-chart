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

export const alertDecisionSchema = Joi.object({
  status: Joi.string().valid(...DECISION_STATUSES).required().messages({
    "any.only": "status must be 'discarded' or 'submitted_for_review'",
  }),
  decision_label: Joi.string().allow(null),
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
  role: Joi.string().valid(...ROLES).required(),
  organization_id: uuid.required(),
  site_ids: Joi.array().items(uuid).default([]),
});

export const updateUserSchema = Joi.object({
  id: uuid.required(),
  email: email,
  password: Joi.string(),
  full_name: Joi.string(),
  role: Joi.string().valid(...ROLES),
  organization_id: uuid,
  site_ids: Joi.array().items(uuid),
});
