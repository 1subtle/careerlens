-- Generated from SQLAlchemy models; no personal data.

PRAGMA foreign_keys=ON;


CREATE TABLE IF NOT EXISTS api_keys (
	provider VARCHAR NOT NULL,
	ciphertext TEXT NOT NULL,
	updated_at VARCHAR NOT NULL,
	PRIMARY KEY (provider)
)

;


CREATE TABLE IF NOT EXISTS applications (
	application_id VARCHAR NOT NULL,
	job_id VARCHAR NOT NULL,
	resume_id VARCHAR NOT NULL,
	master_resume_id VARCHAR,
	status VARCHAR NOT NULL,
	company VARCHAR,
	role VARCHAR,
	applied_at VARCHAR,
	notes TEXT,
	position INTEGER NOT NULL,
	created_at VARCHAR NOT NULL,
	updated_at VARCHAR NOT NULL,
	PRIMARY KEY (application_id),
	CONSTRAINT uq_application_job_resume UNIQUE (job_id, resume_id)
)

;

CREATE INDEX IF NOT EXISTS ix_applications_job_id ON applications (job_id);

CREATE INDEX IF NOT EXISTS ix_applications_resume_id ON applications (resume_id);

CREATE INDEX IF NOT EXISTS ix_applications_status ON applications (status);


CREATE TABLE IF NOT EXISTS direction_history (
	id VARCHAR NOT NULL,
	resume_id VARCHAR NOT NULL,
	resume_hash VARCHAR NOT NULL,
	input_snapshot JSON NOT NULL,
	input_hash VARCHAR NOT NULL,
	result JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id)
)

;

CREATE INDEX IF NOT EXISTS ix_direction_history_created_at ON direction_history (created_at);

CREATE INDEX IF NOT EXISTS ix_direction_history_resume_id ON direction_history (resume_id);


CREATE TABLE IF NOT EXISTS improvements (
	request_id VARCHAR NOT NULL,
	original_resume_id VARCHAR NOT NULL,
	tailored_resume_id VARCHAR NOT NULL,
	job_id VARCHAR NOT NULL,
	improvements JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (request_id)
)

;

CREATE INDEX IF NOT EXISTS ix_improvements_tailored_resume_id ON improvements (tailored_resume_id);


CREATE TABLE IF NOT EXISTS jobs (
	job_id VARCHAR NOT NULL,
	content TEXT NOT NULL,
	resume_id VARCHAR,
	created_at VARCHAR NOT NULL,
	metadata_json JSON NOT NULL,
	version INTEGER DEFAULT '1' NOT NULL,
	PRIMARY KEY (job_id)
)

;


CREATE TABLE IF NOT EXISTS market_history (
	id VARCHAR NOT NULL,
	source VARCHAR NOT NULL,
	input_snapshot JSON NOT NULL,
	input_hash VARCHAR NOT NULL,
	result JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id)
)

;

CREATE INDEX IF NOT EXISTS ix_market_history_created_at ON market_history (created_at);


CREATE TABLE IF NOT EXISTS resumes (
	resume_id VARCHAR NOT NULL,
	content TEXT NOT NULL,
	content_type VARCHAR NOT NULL,
	filename VARCHAR,
	is_master BOOLEAN NOT NULL,
	parent_id VARCHAR,
	processed_data JSON,
	processing_status VARCHAR NOT NULL,
	processing_token VARCHAR,
	cover_letter TEXT,
	outreach_message TEXT,
	interview_prep TEXT,
	title VARCHAR,
	template_settings JSON,
	original_markdown TEXT,
	created_at VARCHAR NOT NULL,
	updated_at VARCHAR NOT NULL,
	PRIMARY KEY (resume_id)
)

;

CREATE UNIQUE INDEX IF NOT EXISTS ux_resumes_single_master ON resumes (is_master) WHERE is_master = 1;


CREATE TABLE IF NOT EXISTS tailoring_previews (
	improvements JSON,
	preview_id VARCHAR NOT NULL,
	source_id VARCHAR NOT NULL,
	job_id VARCHAR NOT NULL,
	payload_hash VARCHAR NOT NULL,
	source_hash VARCHAR NOT NULL,
	job_hash VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	expires_at VARCHAR NOT NULL,
	result_resume_id VARCHAR,
	claim_token VARCHAR,
	claim_expires_at VARCHAR,
	response_data JSON,
	PRIMARY KEY (preview_id)
)

;

CREATE INDEX IF NOT EXISTS ix_preview_compatibility ON tailoring_previews (source_id, job_id, payload_hash, created_at);

CREATE INDEX IF NOT EXISTS ix_tailoring_previews_expires_at ON tailoring_previews (expires_at);

CREATE INDEX IF NOT EXISTS ix_tailoring_previews_job_id ON tailoring_previews (job_id);

CREATE INDEX IF NOT EXISTS ix_tailoring_previews_result_resume_id ON tailoring_previews (result_resume_id);

CREATE INDEX IF NOT EXISTS ix_tailoring_previews_source_id ON tailoring_previews (source_id);


CREATE TABLE IF NOT EXISTS resume_snapshots (
	id VARCHAR NOT NULL,
	resume_id VARCHAR NOT NULL,
	content_hash VARCHAR NOT NULL,
	data JSON NOT NULL,
	evidence JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(resume_id) REFERENCES resumes (resume_id) ON DELETE CASCADE
)

;

CREATE INDEX IF NOT EXISTS ix_resume_snapshots_resume_id ON resume_snapshots (resume_id);


CREATE TABLE IF NOT EXISTS match_records (
	id VARCHAR NOT NULL,
	snapshot_id VARCHAR NOT NULL,
	job_id VARCHAR NOT NULL,
	job_snapshot JSON NOT NULL,
	job_hash VARCHAR NOT NULL,
	details JSON NOT NULL,
	conditions JSON NOT NULL,
	score FLOAT,
	rule_version VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(snapshot_id) REFERENCES resume_snapshots (id) ON DELETE CASCADE,
	FOREIGN KEY(job_id) REFERENCES jobs (job_id) ON DELETE CASCADE
)

;

CREATE INDEX IF NOT EXISTS ix_match_records_job_id ON match_records (job_id);

CREATE INDEX IF NOT EXISTS ix_match_records_snapshot_id ON match_records (snapshot_id);


CREATE TABLE IF NOT EXISTS rewrite_records (
	id VARCHAR NOT NULL,
	match_id VARCHAR NOT NULL,
	section_id VARCHAR NOT NULL,
	facts JSON NOT NULL,
	payload JSON NOT NULL,
	status VARCHAR NOT NULL,
	result_resume_id VARCHAR,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(match_id) REFERENCES match_records (id) ON DELETE CASCADE,
	FOREIGN KEY(result_resume_id) REFERENCES resumes (resume_id) ON DELETE SET NULL
)

;

CREATE INDEX IF NOT EXISTS ix_rewrite_records_match_id ON rewrite_records (match_id);
