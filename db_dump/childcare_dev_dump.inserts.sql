--
-- PostgreSQL database dump
--

\restrict sIdb8sDQVTJSF0I6xKk3v9kXgwRlbLIdPFeX2OnBfHQgwJ1yYBCz2wwtuDePCyf

-- Dumped from database version 16.14 (Homebrew)
-- Dumped by pg_dump version 16.14 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: alertstatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alertstatus AS ENUM (
    'unprocessed',
    'discarded',
    'submitted_for_review',
    'incident'
);


--
-- Name: footageaccessaction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.footageaccessaction AS ENUM (
    'clip_viewed',
    'discarded',
    'submitted_for_review',
    'incident'
);


--
-- Name: userrole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.userrole AS ENUM (
    'operator',
    'site_admin',
    'superuser'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    camera_id character varying NOT NULL,
    alert_type character varying NOT NULL,
    start_timestamp timestamp with time zone NOT NULL,
    end_timestamp timestamp with time zone NOT NULL,
    nx_bookmark_id character varying,
    status public.alertstatus NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    decision_label character varying
);


--
-- Name: device_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token character varying NOT NULL,
    platform character varying NOT NULL
);


--
-- Name: footage_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.footage_access_log (
    id uuid NOT NULL,
    alert_id uuid NOT NULL,
    user_id uuid,
    accessed_at timestamp with time zone NOT NULL,
    action public.footageaccessaction NOT NULL,
    user_email character varying NOT NULL,
    user_full_name character varying NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid NOT NULL,
    name character varying NOT NULL
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id uuid NOT NULL,
    name character varying NOT NULL,
    nx_host character varying NOT NULL,
    nx_username character varying NOT NULL,
    nx_password_encrypted character varying NOT NULL,
    organization_id uuid NOT NULL,
    site_token character varying NOT NULL,
    nx_tls_cert character varying,
    latitude double precision,
    longitude double precision
);


--
-- Name: user_site_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_site_permissions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying NOT NULL,
    hashed_password character varying NOT NULL,
    full_name character varying NOT NULL,
    role public.userrole NOT NULL,
    organization_id uuid NOT NULL,
    account_created date NOT NULL,
    is_active boolean NOT NULL
);


--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.alembic_version (version_num) VALUES
	('a7e3f1c9b204');


--
-- Data for Name: alerts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.alerts (id, site_id, camera_id, alert_type, start_timestamp, end_timestamp, nx_bookmark_id, status, decided_by, decided_at, created_at, decision_label) VALUES
	('24795889-62fc-4152-a559-90bb9eb0bc47', '56f1dc59-39c9-4759-bf92-006be5b37a12', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'person_alone_with_child', '2026-06-05 19:30:00+10', '2026-06-05 19:31:00+10', NULL, 'discarded', 'd53f5b70-0a39-4c72-9af6-cdde6941b8cd', '2026-06-15 17:40:10.688103+10', '2026-06-05 10:04:30.845329+10', NULL),
	('f31b4709-65c9-4d46-985e-4af0a041466f', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'person_alone_with_child', '2026-06-15 19:23:22.897982+10', '2026-06-15 19:24:22.897982+10', NULL, 'unprocessed', NULL, NULL, '2026-06-15 19:23:22.897982+10', NULL),
	('ac54779d-7b2a-4ace-a8d3-b37654ba3fa0', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-15 19:09:22.897982+10', '2026-06-15 19:10:22.897982+10', NULL, 'unprocessed', NULL, NULL, '2026-06-15 19:09:22.897982+10', NULL),
	('a1c2d0df-7dd3-4038-9df2-8724c4c9ce5d', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_in_no_go_zone', '2026-06-15 18:50:22.897982+10', '2026-06-15 18:51:22.897982+10', NULL, 'unprocessed', NULL, NULL, '2026-06-15 18:50:22.897982+10', NULL),
	('455c96c3-f620-4aa6-99aa-b3aa0e79afa7', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_alone', '2026-06-15 18:18:22.897982+10', '2026-06-15 18:19:22.897982+10', NULL, 'unprocessed', NULL, NULL, '2026-06-15 18:18:22.897982+10', NULL),
	('93235a32-dcfd-4a3c-8772-1535f8ab64bb', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-15 17:46:22.897982+10', '2026-06-15 17:47:22.897982+10', NULL, 'unprocessed', NULL, NULL, '2026-06-15 17:46:22.897982+10', NULL),
	('13c4d862-eb4a-4a22-9e8e-f65746c1af4d', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'person_alone_with_child', '2026-06-15 11:16:22.897982+10', '2026-06-15 11:17:22.897982+10', NULL, 'submitted_for_review', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '2026-06-15 11:31:22.897982+10', '2026-06-15 11:16:22.897982+10', 'management_review'),
	('267c46fd-4c4a-4ecf-9b82-d1ea611e8cc0', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_in_no_go_zone', '2026-06-15 08:26:22.897982+10', '2026-06-15 08:27:22.897982+10', NULL, 'submitted_for_review', '66d1787f-16f3-4089-96ea-840820326ce4', '2026-06-15 08:41:22.897982+10', '2026-06-15 08:26:22.897982+10', 'investigation'),
	('005b4190-bede-4354-a5dd-dc5d9e0cb3b9', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_alone', '2026-06-15 05:31:22.897982+10', '2026-06-15 05:32:22.897982+10', NULL, 'submitted_for_review', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '2026-06-15 05:46:22.897982+10', '2026-06-15 05:31:22.897982+10', 'pending'),
	('3f163382-15e7-4627-bea2-fea026baa00d', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-15 02:31:22.897982+10', '2026-06-15 02:32:22.897982+10', NULL, 'submitted_for_review', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-06-15 02:46:22.897982+10', '2026-06-15 02:31:22.897982+10', 'approval_to_close'),
	('48084628-1caa-4053-9dd2-736fbd974513', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'possibly_staff', '2026-06-14 19:01:22.897982+10', '2026-06-14 19:02:22.897982+10', NULL, 'discarded', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-06-14 19:31:22.897982+10', '2026-06-14 19:01:22.897982+10', 'false alarm'),
	('a1f0014d-5abb-4bdf-b1d3-a946b57e65ab', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_alone', '2026-06-14 18:31:22.897982+10', '2026-06-14 18:32:22.897982+10', NULL, 'discarded', '66d1787f-16f3-4089-96ea-840820326ce4', '2026-06-14 19:01:22.897982+10', '2026-06-14 18:31:22.897982+10', 'false positive'),
	('2f730092-fc33-4376-8967-4bd3e8cdabbe', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-14 17:31:22.897982+10', '2026-06-14 17:32:22.897982+10', NULL, 'discarded', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '2026-06-14 18:01:22.897982+10', '2026-06-14 17:31:22.897982+10', 'false alarm'),
	('99cb7afd-74d5-478b-ae41-06181cf9283f', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_in_no_go_zone', '2026-06-14 15:31:22.897982+10', '2026-06-14 15:32:22.897982+10', NULL, 'discarded', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-06-14 16:01:22.897982+10', '2026-06-14 15:31:22.897982+10', 'false positive'),
	('fdc4978d-9ec8-4837-9cc3-2557d91fceae', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'person_alone_with_child', '2026-06-13 23:31:22.897982+10', '2026-06-13 23:32:22.897982+10', NULL, 'incident', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '2026-06-14 00:01:22.897982+10', '2026-06-13 23:31:22.897982+10', 'genuine'),
	('593e2c5e-5e9b-42cf-8beb-20203879efc1', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_alone', '2026-06-13 21:31:22.897982+10', '2026-06-13 21:32:22.897982+10', NULL, 'discarded', '66d1787f-16f3-4089-96ea-840820326ce4', '2026-06-13 22:01:22.897982+10', '2026-06-13 21:31:22.897982+10', 'false alarm'),
	('075ce5e5-c204-47e9-ad35-9613da20ae60', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-13 19:31:22.897982+10', '2026-06-13 19:32:22.897982+10', NULL, 'discarded', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-06-13 20:01:22.897982+10', '2026-06-13 19:31:22.897982+10', 'false positive'),
	('17f61cf7-00e2-4e65-9215-408ba8c8e454', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_alone', '2026-06-12 20:30:00+10', '2026-06-12 20:30:00+10', NULL, 'discarded', '66d1787f-16f3-4089-96ea-840820326ce4', '2026-06-12 21:00:00+10', '2026-06-12 20:30:00+10', 'false alarm'),
	('95870a2c-d551-4a28-82ae-17617e960e05', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'blacklisted_vehicle', '2026-06-12 00:15:00+10', '2026-06-12 00:15:00+10', NULL, 'discarded', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-06-12 00:45:00+10', '2026-06-12 00:15:00+10', 'false positive'),
	('1398c2ae-8dd0-4d54-ab0d-d0c3190c3f82', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'child_in_no_go_zone', '2026-05-27 21:00:00+10', '2026-05-27 21:00:00+10', NULL, 'discarded', '66d1787f-16f3-4089-96ea-840820326ce4', '2026-05-27 21:30:00+10', '2026-05-27 21:00:00+10', 'false alarm'),
	('28bac270-33a5-40c0-93ed-a6d20a800a3d', '248a35d2-d764-46a6-9bf8-d5029719360c', '{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}', 'person_alone_with_child', '2026-04-18 02:20:00+10', '2026-04-18 02:20:00+10', NULL, 'discarded', '910d66fc-a613-43f0-9ce2-cd361928e867', '2026-04-18 02:50:00+10', '2026-04-18 02:20:00+10', 'false positive');


--
-- Data for Name: device_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: footage_access_log; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.footage_access_log (id, alert_id, user_id, accessed_at, action, user_email, user_full_name) VALUES
	('98b3f9d9-6512-4cc9-bd6a-f555e9308c00', '24795889-62fc-4152-a559-90bb9eb0bc47', 'd53f5b70-0a39-4c72-9af6-cdde6941b8cd', '2026-06-05 10:04:30.930949+10', 'submitted_for_review', 'admin@example.com', 'Admin'),
	('44acefcf-3c13-4626-9625-925d46ebbd6d', '24795889-62fc-4152-a559-90bb9eb0bc47', 'd53f5b70-0a39-4c72-9af6-cdde6941b8cd', '2026-06-15 17:40:10.688103+10', 'discarded', 'admin@example.com', 'Admin'),
	('9f6a4f7f-bead-4fbe-9980-a1ab2588bf87', '24795889-62fc-4152-a559-90bb9eb0bc47', 'd53f5b70-0a39-4c72-9af6-cdde6941b8cd', '2026-06-15 19:05:08.183925+10', 'clip_viewed', 'admin@example.com', 'Admin'),
	('21c6ec63-be0f-4039-b7e4-76eb920b81cd', '24795889-62fc-4152-a559-90bb9eb0bc47', 'd53f5b70-0a39-4c72-9af6-cdde6941b8cd', '2026-06-15 19:06:11.79978+10', 'clip_viewed', 'admin@example.com', 'Admin');


--
-- Data for Name: organizations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organizations (id, name) VALUES
	('3f1fbba7-0314-438c-a47b-03d1902c0cb9', 'Art of Logic'),
	('99e09b76-abde-47d5-8c98-78732bf3e77d', 'Sunshine Childcare Group'),
	('ee8ba1d6-1f05-47ac-88a1-ba1833ddeaf2', 'Sunshine Childcare Group'),
	('258be96d-a078-47ef-92e9-087a56e6755c', 'Ascension Cloud Solutions'),
	('aef7219a-fcdf-4480-84fb-418824ad2386', 'SafeDay Wiring Smoke Test'),
	('8eebe3de-3dca-4820-b74e-b3c6ac0d898f', 'Tasman Childcare Group'),
	('0b6017db-086c-4d29-a258-f26b9a5dca16', 'ACS Childcare'),
	('d9393af7-5067-45eb-8412-353fe8d9c45d', 'BG Email Test Org'),
	('84e079a3-4172-4c93-b8ae-c6ae5971700a', 'PUT Test Org'),
	('d594252c-c3c8-4403-a7af-8822b75aacd9', 'PUT Test Org 2'),
	('0a4f46d1-dcd6-48a1-a03e-6bac41743f5b', 'Harbour Kids Group'),
	('0fc645b9-ca66-4a16-93ff-f0a7ff00a1fa', 'Resend Test Org'),
	('64f5b68f-fca1-47a4-8b2c-f0fd990db543', 'Resend Org 3'),
	('e3224a0b-c512-43b3-8f51-823a68fac92a', 'Verify Flow Org'),
	('7324f666-1604-4791-9b1c-ab5d08de8f00', 'Verify Flow Org 2'),
	('bd4dee70-57cf-46bd-b93a-0f95dc50e08b', 'ACS Childcare V2'),
	('7fa746a4-a50b-416d-b81f-bfda74669d5c', 'Email Send Test Org'),
	('cb0e5e0c-2f2c-479d-bf3d-350d43a79526', 'ACS Childcare V3'),
	('fd01dad4-0b4f-48b0-9ed1-e04ebfc22c56', 'ACS Childcare V3'),
	('40e857ef-9dbb-42d4-b576-e8e664bd60a6', 'ACS Childcare V4'),
	('52f58bee-0e24-4fcd-a02e-de6e4d117fb0', 'ACS Childcare V5'),
	('614ef3fd-b8b6-4f67-bfac-081b7b944ddc', 'ACS Childcare V6'),
	('d2a829bd-b94f-417e-b710-45a5bd287638', 'ACS Childcare V7'),
	('5dca2a98-7bf7-45f1-8724-45a0b14864d7', 'ACS Childcare V8'),
	('426b9740-0b07-4c7c-830e-3bf0e45299b8', 'ACS Childcare V8'),
	('9f12b78c-c5ab-4c01-b785-cb54cf230971', 'ACS Childcare V9'),
	('93d3b24e-7e58-4984-8419-4609096b016c', 'ACS Childcare V10'),
	('49bd4f0c-0711-4f9e-ac67-e56bf5fec8a1', 'NoSites Org');


--
-- Data for Name: sites; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sites (id, name, nx_host, nx_username, nx_password_encrypted, organization_id, site_token, nx_tls_cert, latitude, longitude) VALUES
	('56f1dc59-39c9-4759-bf92-006be5b37a12', 'Sunshine Centre', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqIhKOm0C5EqO9Q6xNCp9t8Lce0oNqhFHqX69v8xvO-vBtdeb4xn0xgWg-Mghs3o50BIEIcM_F5hsXO2FE1jZbC4mgCA==', '99e09b76-abde-47d5-8c98-78732bf3e77d', 'sunshine-centre', NULL, NULL, NULL),
	('248a35d2-d764-46a6-9bf8-d5029719360c', 'ACS Child Care Centre', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqLqNSE95VgJZ9lpy_HFQOeQ1z_4TVIZvOlT7Z03CQ_5NZO6cg5hxhuP5v0p_TQkbcyLBZzl5Ny2tpL9b3XF6zQBx9EQ==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre', NULL, -33.8688, 151.2093),
	('8d194f08-1116-4740-aa8d-61ae3de3a63e', 'ACS Child Care Centre - Bluegum', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqL6qWEcY433XhN913ZkanUfAvRL-TXqZ987nF1M0MAgrN_1-z8n6qlPxdHHxHnMgBtC_iYuV0iJKcsS-7iLY7Uw1zXA==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre-bluegum-lane-cove', NULL, -33.8126, 151.1683),
	('72ba3da7-25c1-498e-922f-04ec41e62a1b', 'ACS Child Care Centre - Saltbush', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqL6qW5o91W35TF3Ph3EdLacQdYTRzAqdKb8wRCbrfUsThtVw3uFWXAk5cXhGzgTsixMrC8W1RDcmJUAsI-8UGUK9ZGw==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre-saltbush-manly', NULL, -33.7969, 151.2876),
	('71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7', 'ACS Child Care Centre - Pelican Bay', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqL6qWL8pq4wrIadaZeSJ2Bh5nDd6Dn0Ch-Z4GPIwv0VYLV7I1p-9MYqYRQG_k9iMb-Boa4jAULFoLLkAa503PLnUbqg==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre-pelican-bay-newcastle', NULL, -32.9283, 151.7817),
	('3d465325-81f3-42a1-a0d6-582092db7b97', 'ACS Child Care Centre - Northbridge Sails', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqL6qW8Y95K-F8AdZAhDbO8TQqJ8MXTSKVsVbRUSqz52f3PnHbyMAWKBY4P1StUxksvN71mUNECUUTE-9RbP9DdjP4bw==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre-northbridge-sails', NULL, -33.8067, 151.2161),
	('7e55ab39-acb9-4f4e-be04-2ca66463aff9', 'ACS Child Care Centre - Pyrmont Pier', 'https://192.168.1.10:7001', 'admin', 'gAAAAABqL6qWscBAClAV99NO7josfPPt033Jk9cA-Z-GowVfTpFO25flj8z8V-iyCcgA8urBRmbZ9KpfbvNChLZZ5oq13_0Djw==', '93d3b24e-7e58-4984-8419-4609096b016c', 'acs-child-centre-pyrmont-pier', NULL, -33.8694, 151.1956);


--
-- Data for Name: user_site_permissions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.user_site_permissions (id, user_id, site_id) VALUES
	('e266937e-0fa1-4488-b4b5-0f6762448031', 'ee1e3c17-a198-4c60-a94e-6ff711f14307', '56f1dc59-39c9-4759-bf92-006be5b37a12'),
	('9c1c8687-7423-444d-a83d-42dbaf430df8', 'ee1e3c17-a198-4c60-a94e-6ff711f14307', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('7071c200-2b87-42ba-b69c-a351bf436cb2', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('e5a8c8a7-bb6a-4369-a9c4-f80ca7513a8e', '50d02322-9640-4f95-9c31-ce214ca80c3c', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('b27bc486-01fe-4da3-8377-e7951406a42e', 'd640187b-5f00-4a47-81af-59af22edf625', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('63928256-875d-4c86-b17e-099cf5217a53', '21522f79-d271-41d3-a31a-3f80d94d17b6', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('c52575ce-a90e-49ec-9848-6611a661b405', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('31237b9d-e77b-42a4-b4ce-bfa5c72d1855', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('ecaca53d-8cbe-4396-be10-9b2ce5dc9633', '66d1787f-16f3-4089-96ea-840820326ce4', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('e6df6216-aa7b-45d0-b043-fb10052d7ac2', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('7ff875dd-3d30-4e04-bb5f-fb0b6a6f8c19', '910d66fc-a613-43f0-9ce2-cd361928e867', '248a35d2-d764-46a6-9bf8-d5029719360c'),
	('f21fb877-7c13-4c06-a83d-b951cfd34a06', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('145abd90-4ec0-4f16-84e9-a28e47ee940f', '50d02322-9640-4f95-9c31-ce214ca80c3c', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('a410dc79-86b5-4560-b0a5-4ea728743808', 'd640187b-5f00-4a47-81af-59af22edf625', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('c38b5aab-e061-41a0-8769-b7e803f497e0', '21522f79-d271-41d3-a31a-3f80d94d17b6', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('026ac515-9cfd-4e64-b238-b2bf985f5998', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('f110dd9d-9ef5-463e-aa0b-3c44fdcb9d61', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('c3ba64b2-1121-466f-95a8-e65c188d67a8', '66d1787f-16f3-4089-96ea-840820326ce4', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('73b7a486-0d54-4518-be28-588d3fe6e38a', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('e51273aa-47f9-4047-8173-b1c298b0c2d4', '910d66fc-a613-43f0-9ce2-cd361928e867', '8d194f08-1116-4740-aa8d-61ae3de3a63e'),
	('4adf7ef9-27ae-4240-bd8e-c6de2ff8f6cf', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('abc78606-ce57-4110-b39b-8f0e17e34369', '50d02322-9640-4f95-9c31-ce214ca80c3c', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('c8113573-c997-4a66-b9e4-9590d6cb2f43', 'd640187b-5f00-4a47-81af-59af22edf625', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('f8e5c4e5-be35-4e40-b0cd-b183696a6498', '21522f79-d271-41d3-a31a-3f80d94d17b6', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('3b35fd02-43d7-420a-a7ba-0ce8b4e7c725', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('0df59b31-bab2-42cc-94ec-0e51207d2897', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('21b0b10b-5202-4be3-be5b-f1d50a017f1c', '66d1787f-16f3-4089-96ea-840820326ce4', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('e7dba4ec-42f8-4ada-a70a-d58a2d028a4c', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('5f3f20ca-d334-4d84-987b-8a5843068621', '910d66fc-a613-43f0-9ce2-cd361928e867', '72ba3da7-25c1-498e-922f-04ec41e62a1b'),
	('4a4c2c91-af84-4b5c-a413-7965a0281c18', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('9f27c538-f9a0-422b-ab6f-e790f9f7c253', '50d02322-9640-4f95-9c31-ce214ca80c3c', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('3c955e8e-37df-4812-a2b3-57f7dc24e834', 'd640187b-5f00-4a47-81af-59af22edf625', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('b335645f-c02b-4f96-afab-85b1c9752e9a', '21522f79-d271-41d3-a31a-3f80d94d17b6', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('3e361cee-4479-4988-842a-5d788f3cf6bd', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('84216e07-7111-47f2-8fdf-ee08f7d748fb', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('4c9665c6-4da7-42e3-8fa3-b7c2b21cfafc', '66d1787f-16f3-4089-96ea-840820326ce4', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('d4ef9198-cebe-4f0c-9887-9d1da32fa17e', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('70974fb8-ea5e-4ffc-98c0-56d4bdcc4ea4', '910d66fc-a613-43f0-9ce2-cd361928e867', '71904d60-8eaf-4e3f-b5c6-8f7adbfef2d7'),
	('2454c5a1-c8c3-4fe6-a084-26561b2cafb3', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('31486471-f00f-46bc-a3f1-483da429f603', '50d02322-9640-4f95-9c31-ce214ca80c3c', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('26c6fe66-7bab-4bd9-be00-53feca45aa0e', 'd640187b-5f00-4a47-81af-59af22edf625', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('c41b99c1-61e7-4a4c-baaa-ee69410cf1c0', '21522f79-d271-41d3-a31a-3f80d94d17b6', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('6e257389-4ca2-44dc-a3e6-37f211893e10', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('7ac0ad53-0688-4571-9ee5-85f61d78aa50', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('41a6841b-0319-4f8b-af51-6c7b4f8066bf', '66d1787f-16f3-4089-96ea-840820326ce4', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('302686fe-e123-49d1-a5ea-dbf95fdbfba1', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('b2bad51a-3718-4c02-a2d0-bc679c737a5f', '910d66fc-a613-43f0-9ce2-cd361928e867', '3d465325-81f3-42a1-a0d6-582092db7b97'),
	('bc1b9a47-e532-4054-b7cf-5fed5893e63e', 'c63f68c9-e64c-4f94-b24e-057c17462b39', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('9711d908-39ce-4e95-97a7-f4a8c74e42c0', '50d02322-9640-4f95-9c31-ce214ca80c3c', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('78798a02-b38a-4ae8-9ee2-0a48d9a944ce', 'd640187b-5f00-4a47-81af-59af22edf625', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('1b210123-0c83-4a84-99f7-77dbe61ad904', '21522f79-d271-41d3-a31a-3f80d94d17b6', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('de91404d-ffba-4f2c-97e4-dfe4d45a4c77', '443e5131-91eb-4c88-91b8-52ed21e60dd2', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('2b6839ce-052a-4d7a-968c-9bcbc6917322', 'c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('bbc955d7-fb76-4282-b14d-06107686dbc5', '66d1787f-16f3-4089-96ea-840820326ce4', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('fec74089-f9be-4481-b2f9-9de912acbd6b', '8747272a-39e5-4a36-b8df-0ebdf56a9013', '7e55ab39-acb9-4f4e-be04-2ca66463aff9'),
	('bb04c571-004d-453e-95c3-37c2c2030f1e', '910d66fc-a613-43f0-9ce2-cd361928e867', '7e55ab39-acb9-4f4e-be04-2ca66463aff9');


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.users (id, email, hashed_password, full_name, role, organization_id, account_created, is_active) VALUES
	('5ad1341e-949d-4aab-b091-626d972338e1', 'jane.smith@example.com', '$2b$12$R8mUn9.IUfYZ4Q31Ccfar.0C9F4gNGEz0c92o4qziOXAjA1z76ezO', 'Jane Smith', 'site_admin', '99e09b76-abde-47d5-8c98-78732bf3e77d', '2026-06-05', true),
	('19a1c132-a98c-4119-b44c-70dc77c937a7', 'conner@ascensioncloudsolutions.com', '$2b$12$gQ/Es8VxNh5Lj.fFBzqcZueLV3l/aR7GBRNxqFMosdKhJ3uyrMzrm', 'Jane Smith', 'site_admin', '258be96d-a078-47ef-92e9-087a56e6755c', '2026-06-14', true),
	('225ab65e-c55d-4299-80ae-d0ca14b3d6ca', 'conner+8@ascensioncloudsolutions.com', '$2b$12$/PihKfyUHJG1GGVIHTXUDOuanxfYH2wd5TYffK7Xmq1b2ndoduiLG', 'Conner Goldberg', 'site_admin', '9f12b78c-c5ab-4c01-b785-cb54cf230971', '2026-06-15', true),
	('d53f5b70-0a39-4c72-9af6-cdde6941b8cd', 'admin@example.com', '$2b$12$Qc1rBb909iuOH0LTLp/Cx.3XKJ2u/c0VQ3dhGMQc/0PIXHtJ1DFAm', 'Admin', 'superuser', '3f1fbba7-0314-438c-a47b-03d1902c0cb9', '2026-06-05', true),
	('ee1e3c17-a198-4c60-a94e-6ff711f14307', 'conner+11@ascensioncloudsolutions.com', '$2b$12$UOFsLCeMWRMlJ/sE.kH6cetayoAkuPMiM.NjhPUemc5lgZuf6qWnm', 'Conner Goldberg', 'site_admin', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('18573b44-eb41-497b-b12b-71057e4594a5', 'nosites-1781457236@example.com', '$2b$12$CJkgLqP1IoGqnZEnUf4/SO54AcSZjXcuJv8kgPiTQINcPYqsBPzd.', 'Riley Nosites', 'site_admin', '49bd4f0c-0711-4f9e-ac67-e56bf5fec8a1', '2026-06-15', true),
	('ff832c23-4413-4beb-9e3e-c81fd4fdf25e', 'prospect-1781446427@example.com', '$2b$12$avW9SsnFGxyTs7e/EhlrMe0bsAKeG2di7PnTU5VMzfYXJnqTjOPbW', 'Jane Prospect', 'site_admin', 'd9393af7-5067-45eb-8412-353fe8d9c45d', '2026-06-15', true),
	('78545989-dce7-4362-accc-1ae78dc906f1', 'puttest-1781446445@example.com', '$2b$12$SHb4L.itiFvdv5ltsfK15uxhwAZXpXaaQrOb/UDHRoNZoHPQmK8Yi', 'Put Tester', 'site_admin', '84e079a3-4172-4c93-b8ae-c6ae5971700a', '2026-06-15', true),
	('0818a6f7-11a3-4e84-8d2c-7a4f29933f42', 'puttest-1781446459@example.com', '$2b$12$v3jFL0ETx71J964STFW9luQao0Ur5Ekk1O6LXIQThL6USBFn1vN.S', 'Put Tester', 'site_admin', 'd594252c-c3c8-4403-a7af-8822b75aacd9', '2026-06-15', true),
	('ed7669fc-d403-4d54-abdf-9a452225bac6', 'prospect-1781446672@centre.com.au', '$2b$12$nltFUOuB2wwpsQSmQhpc7ONOWWLyFA5ozDo6g/kh3oRAdF7rPjqKq', 'Jane Connor', 'site_admin', '0a4f46d1-dcd6-48a1-a03e-6bac41743f5b', '2026-06-15', true),
	('f21766e1-ce2d-45d6-9e55-78df76506988', 'resend-1781448539@example.com', '$2b$12$eWZP4Kv8IaLHyRbORMAVp.ocPrWPQAIRZ6iBpL1fP8YZRtwAi3JJ2', 'Resend Tester', 'site_admin', '0fc645b9-ca66-4a16-93ff-f0a7ff00a1fa', '2026-06-15', true),
	('b4714662-1b9c-40b1-bcf7-41bc3202e13b', 'resend3-1781448662@example.com', '$2b$12$J81m7zvsLzye.90InQVQsuOPTj5loyZUvCE7WqaUy3Odt10STPbYu', 'Resend Tester', 'site_admin', '64f5b68f-fca1-47a4-8b2c-f0fd990db543', '2026-06-15', true),
	('c3428634-7bdb-4272-a72b-13a89b81c294', 'verify-1781448919@centre.com.au', '$2b$12$dPnzU//I/wBF7Nuxyb..ueU45i9qjrXg.7bODiMa/vzLSR7U1mDKC', 'Verify Jane', 'site_admin', 'e3224a0b-c512-43b3-8f51-823a68fac92a', '2026-06-15', true),
	('3c382233-a169-4b46-aeed-41f15b25e94f', 'verify2-1781448964@centre.com.au', '$2b$12$ZSfyLTAdwPQlnw1lqUz7pu9w83s.31dSji1PR5xW6avubFfbP.tGW', 'Verify Jane', 'site_admin', '7324f666-1604-4791-9b1c-ab5d08de8f00', '2026-06-15', true),
	('352cbf66-4d23-4072-86b4-6f679c39f8ea', 'emailtest-1781449632@centre.com.au', '$2b$12$jex20p14Kt5SksjV2/FlFO2Q0JRpPVAUk3sGS831aKjHK9ylZkpoa', 'Email Tester', 'site_admin', '7fa746a4-a50b-416d-b81f-bfda74669d5c', '2026-06-15', true),
	('56ab08af-8804-4c52-a107-c1f8622ffe57', 'conner+2@ascensioncloudsolutions.com', '$2b$12$3X6805d8IHtqbndviphbk.QcUqfVo3AkGykstZQBpz2l/656Q2Pim', 'Conner Goldberg', 'site_admin', '40e857ef-9dbb-42d4-b576-e8e664bd60a6', '2026-06-15', true),
	('65f65063-a976-4a9a-a49d-961e8cafca7c', 'conner+1@ascensioncloudsolutions.com', '$2b$12$el.EkLrxVrxGd4Z6oq2treWgL6hE4E3hPIcafDPsA4EYtlt.b9d7S', 'Conner Goldberg', 'site_admin', '52f58bee-0e24-4fcd-a02e-de6e4d117fb0', '2026-06-15', true),
	('cb729715-3765-4223-88c6-9263dc275f1a', 'conner+3@ascensioncloudsolutions.com', '$2b$12$thqcriAAVUjrHorkd9/FjuJTQ8wOdNEdrU6yhYQoUqHcLuTM2LA52', 'Conner Goldberg', 'site_admin', '614ef3fd-b8b6-4f67-bfac-081b7b944ddc', '2026-06-15', true),
	('d9c4e5eb-6d8b-4dd2-b132-8e66e49fd887', 'conner+4@ascensioncloudsolutions.com', '$2b$12$n/7lrd73Hjo0OfMrF9x6t.fzc4SmFM.erJltIkiFCeCL4u3k9o3tW', 'Conner Goldberg', 'site_admin', 'd2a829bd-b94f-417e-b710-45a5bd287638', '2026-06-15', true),
	('c2def486-8891-4b32-bdc5-3357854fd1cd', 'conner+5@ascensioncloudsolutions.com', '$2b$12$XydWKmT9ojrhTUxXKhBg5.EKMZqXyACVQxNfcnYTUJE2o52HRNNES', 'Conner Goldberg', 'site_admin', '5dca2a98-7bf7-45f1-8724-45a0b14864d7', '2026-06-15', true),
	('fe3e6de3-8e78-4468-82a3-f675e62d8766', 'conner+6@ascensioncloudsolutions.com', '$2b$12$0J8CFYZ1LaBKgEd6Hfap9esFJsazaRD..a91eUAKjEqm0qwBeDF5a', 'Conner Goldberg', 'site_admin', '426b9740-0b07-4c7c-830e-3bf0e45299b8', '2026-06-15', true),
	('c63f68c9-e64c-4f94-b24e-057c17462b39', 'olivia+11@ascensioncloudsolutions.com', '$2b$12$XoOdj0ExLr0Np9CL.9ybRetW7.OLA1hcec8XfQRUQueRkWU9eb8Qi', 'Olivia Munne', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('50d02322-9640-4f95-9c31-ce214ca80c3c', 'liam+11@ascensioncloudsolutions.com', '$2b$12$cR2nlndqzGDitL9KrLCDFubd5V6P1tsgKni8j9gQ.71jjpFrUprnG', 'Liam Park', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('d640187b-5f00-4a47-81af-59af22edf625', 'noah+11@ascensioncloudsolutions.com', '$2b$12$Demn8dX/ho1BEq5zxusgP.ENF2rPUX7j5nik1gyVgcq2UNLU5bX2u', 'Noah Killian', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('21522f79-d271-41d3-a31a-3f80d94d17b6', 'mia+11@ascensioncloudsolutions.com', '$2b$12$b34cT6VPshUKjm6A3X4BLu2eNxyTS2NkbkhLDmGCWeSSIv3g.AoN6', 'Mia Taylor', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('443e5131-91eb-4c88-91b8-52ed21e60dd2', 'ethan+11@ascensioncloudsolutions.com', '$2b$12$3eBX7c3KaIXp.8QZKR/Bb.Fx/Tp5mhz3MM0yGp0ueZsfCLgmm2le2', 'Ethan Brennan', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('c99c38b5-773c-4d8b-b3bc-31a99d72ccd3', 'jordan+11@ascensioncloudsolutions.com', '$2b$12$/LNS5jo3e8UyIusPzTtCE.yukvtlMB4uHrrEELwJtAcPRsWSa6gYi', 'Jordan Park', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('66d1787f-16f3-4089-96ea-840820326ce4', 'riley+11@ascensioncloudsolutions.com', '$2b$12$m8cdrUeMHFTEgFrfHOwNauti2YPgGY.gni6HHmRW46zEw0EHR1qxC', 'Riley Hughes', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('8747272a-39e5-4a36-b8df-0ebdf56a9013', 'casey+11@ascensioncloudsolutions.com', '$2b$12$qExc1o5B0mdjUAQQrJGF/uSVZwIgvItidM/hQqWQUb.Y1tLfImLJe', 'Casey Tran', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true),
	('910d66fc-a613-43f0-9ce2-cd361928e867', 'morgan+11@ascensioncloudsolutions.com', '$2b$12$iFK0fMBBuH0MO6D29NUFLeD7GAMcKjZ55SaMoT3QZ84iN0MABcap2', 'Morgan Reid', 'operator', '93d3b24e-7e58-4984-8419-4609096b016c', '2026-06-15', true);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_pkey PRIMARY KEY (id);


--
-- Name: footage_access_log footage_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footage_access_log
    ADD CONSTRAINT footage_access_log_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: sites uq_sites_site_token; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT uq_sites_site_token UNIQUE (site_token);


--
-- Name: user_site_permissions uq_user_site; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_site_permissions
    ADD CONSTRAINT uq_user_site UNIQUE (user_id, site_id);


--
-- Name: user_site_permissions user_site_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_site_permissions
    ADD CONSTRAINT user_site_permissions_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: ix_sites_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sites_organization_id ON public.sites USING btree (organization_id);


--
-- Name: ix_sites_site_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_sites_site_token ON public.sites USING btree (site_token);


--
-- Name: ix_user_site_permissions_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_site_permissions_site_id ON public.user_site_permissions USING btree (site_id);


--
-- Name: ix_user_site_permissions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_site_permissions_user_id ON public.user_site_permissions USING btree (user_id);


--
-- Name: ix_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);


--
-- Name: ix_users_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_organization_id ON public.users USING btree (organization_id);


--
-- Name: alerts alerts_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: alerts alerts_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: device_tokens device_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: footage_access_log footage_access_log_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footage_access_log
    ADD CONSTRAINT footage_access_log_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id);


--
-- Name: footage_access_log footage_access_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footage_access_log
    ADD CONSTRAINT footage_access_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sites sites_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: user_site_permissions user_site_permissions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_site_permissions
    ADD CONSTRAINT user_site_permissions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: user_site_permissions user_site_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_site_permissions
    ADD CONSTRAINT user_site_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- PostgreSQL database dump complete
--

\unrestrict sIdb8sDQVTJSF0I6xKk3v9kXgwRlbLIdPFeX2OnBfHQgwJ1yYBCz2wwtuDePCyf

