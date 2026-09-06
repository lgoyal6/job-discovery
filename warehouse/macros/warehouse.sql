{#
  Shared derivations. Kept as macros so the canonical key and the material
  fingerprint have exactly one definition; the operational pipeline's worst
  production bug (migrations 007 and 008) came from two code paths disagreeing
  about what a fingerprint was.
#}

{% macro norm_text(col) -%}
  lower(regexp_replace({{ col }}, '[^a-zA-Z0-9]+', '', 'g'))
{%- endmacro %}

{#- Canonical identity of a requisition. Deliberately excludes location: a
    posting that moves from New York to remote is the same requisition. -#}
{% macro canonical_key(company, title, cycle) -%}
  {{ norm_text(company) }} || '::' || {{ norm_text(title) }} || '::' || {{ norm_text(cycle) }}
{%- endmacro %}

{#- Material fingerprint: the fields whose change is worth calling a new
    version of the requisition. Same three the operational pipeline uses. -#}
{% macro material_fingerprint(title, location, cycle) -%}
  md5({{ norm_text(title) }} || '|' || {{ norm_text(location) }} || '|' || {{ norm_text(cycle) }})
{%- endmacro %}

{#- Trust order over sources. An applicant tracking system is the employer's
    own system of record; an aggregator is a copy of it, and a hand-maintained
    list is a copy of the copy. Only the most trusted source that has ever seen
    a requisition is allowed to mint versions of it, which is what stops three
    sources' three spellings of one office from flapping the fingerprint. -#}
{% macro source_rank(col) -%}
  case {{ col }}
    when 'greenhouse'      then 1
    when 'lever'           then 1
    when 'ashby'           then 1
    when 'smartrecruiters' then 1
    when 'linkedin'        then 5
    when 'intern-list'     then 6
    when 'community'       then 7
    else 9
  end
{%- endmacro %}

{#- Eligibility, stated once. A role is eligible if the graduation window it
    names admits the applicant AND the posting does not say outright that it
    will not sponsor. UNKNOWN sponsorship stays eligible: absence of a promise
    is not a refusal. Every Q1 denominator in the marts uses this and nothing
    else. -#}
{% macro is_eligible(grad_col, sponsorship_col) -%}
  ({{ grad_col }} and {{ sponsorship_col }} <> 'UNSUPPORTED')
{%- endmacro %}

{#- The high-water mark of everything a model has already absorbed, on the
    INGESTION clock. Reading it from the model's own output is what makes the
    incremental run self-describing: there is no side table of watermarks to
    drift out of step with the data. -#}
{% macro ingestion_watermark(col='built_from_ingested_at') -%}
  (select coalesce(max({{ col }}), '-infinity'::timestamptz) from {{ this }})
{%- endmacro %}
