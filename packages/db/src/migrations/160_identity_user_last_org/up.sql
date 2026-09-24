-- 160_identity_user_last_org: per-user "last viewed organization" preference.
--
-- Context: identity
-- Task: console "default to last-used org" — server-backed so the default
--       follows the user across devices/browsers (the client also caches it in
--       localStorage for an instant landing redirect).
--
-- A soft UI hint, not relational data: it stores the org SLUG the user last
-- worked in (the console routes by slug). Nullable, no foreign key — a stale or
-- inaccessible value is self-healed by the console (it clears the hint when the
-- org no longer resolves). Updated on a best-effort, non-blocking path as the
-- user navigates, so it must never add write contention to anything hot.

ALTER TABLE identity_users ADD COLUMN last_org_slug TEXT;
