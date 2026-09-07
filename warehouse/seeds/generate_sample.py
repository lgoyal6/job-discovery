"""Generate the sanitized sample dataset for the job-market warehouse.

Nothing here is real. Every company, requisition, URL and application-status
event is invented. This file is the sanitization boundary: the warehouse is
only ever loaded from its output, never from the operational database that
holds Laksh's actual application data.

Determinism matters. The incremental-vs-full-rebuild parity proof compares two
builds row by row, so the generator must emit byte-identical CSVs on every run:
no now(), no uuid4, no dict iteration that depends on insertion luck.
"""

import csv
import hashlib
import os
from datetime import datetime, timedelta, timezone

OUT = os.path.dirname(os.path.abspath(__file__))

# Day 1 of the observation window. Batch N lands on day N.
DAY1 = datetime(2026, 8, 3, tzinfo=timezone.utc)

# Time of day each source runs, which fixes "who observed it first" ties.
SOURCE_HOUR = {
    "community": 6,
    "intern-list": 7,
    "greenhouse": 9,
    "lever": 10,
    "ashby": 11,
    "linkedin": 15,
}

# Sources that carry posting prose. community and intern-list are link lists:
# they name a role and link out, so a requisition seen only through them has
# no requirements text at all. That is the coverage gap Q3 has to declare.
SOURCES_WITH_PROSE = {"greenhouse", "lever", "ashby", "linkedin"}


def day(n, hour):
    return DAY1 + timedelta(days=n - 1, hours=hour)


def iso(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S+00")


def norm(s):
    return "".join(c for c in s.lower() if c.isalnum())


def canonical_key(company, title, cycle):
    return "%s::%s::%s" % (norm(company), norm(title), norm(cycle))


# ---------------------------------------------------------------------------
# Requisitions. `sources` maps source name to the day numbers on which that
# source observed the posting.
# ---------------------------------------------------------------------------
REQS = [
    dict(
        id="R01", company="Northwind Systems", title="Software Engineer Intern",
        cycle="Summer 2027", category="SWE", location="New York, NY",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=6),
        sources={"greenhouse": [1, 2, 3, 4, 5, 6], "linkedin": [1, 3, 5]},
        requirements="python|sql|distributed systems",
        # linkedin spells the same office differently. Under a naive design that
        # spelling flips the material fingerprint back and forth and mints a new
        # version on every pass. The canonical layer must not let it.
        location_overrides={"linkedin": "New York City"},
    ),
    dict(
        id="R02", company="Northwind Systems", title="Machine Learning Intern",
        cycle="Summer 2027", category="ML/AI", location="New York, NY",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=4),
        sources={"greenhouse": [1, 2, 3, 4, 5, 6], "linkedin": [2, 4, 6]},
        requirements="python|pytorch|machine learning",
    ),
    dict(
        id="R03", company="Acme Robotics", title="Robotics Software Intern",
        cycle="Summer 2027", category="SWE", location="Pittsburgh, PA",
        grad=True, sponsorship="UNKNOWN", posted=day(1, 0) - timedelta(days=9),
        sources={"lever": [1, 2, 3, 4, 5, 6], "linkedin": [1, 3, 5]},
        requirements="c++|ros|linux", closed_from=4,
    ),
    dict(
        # Graduating outside the window the posting names, so not eligible.
        # It is still the only thing lever uniquely carries, which is the point.
        id="R04", company="Acme Robotics", title="Embedded Systems Intern",
        cycle="Summer 2027", category="SWE", location="Pittsburgh, PA",
        grad=False, sponsorship="UNKNOWN", posted=day(1, 0) - timedelta(days=8),
        sources={"lever": [1, 2, 3, 4, 5, 6]},
        requirements="c|embedded|rtos",
    ),
    dict(
        # Community-only, and the posting states it will not sponsor, so it is
        # ineligible. This is the requisition the late correction lands on.
        id="R05", company="Bluewater Capital", title="Quantitative Research Intern",
        cycle="Summer 2027", category="Quant", location="Chicago, IL",
        grad=True, sponsorship="UNSUPPORTED", posted=day(1, 0) - timedelta(days=14),
        sources={"community": [1, 2, 5, 6]},
        requirements="", closed_from=5,
    ),
    dict(
        id="R06", company="Bluewater Capital", title="Software Engineer Intern",
        cycle="Summer 2027", category="SWE", location="Chicago, IL",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=5),
        sources={"ashby": [1, 2, 3, 4, 5, 6], "linkedin": [2, 4, 6]},
        requirements="python|sql|golang",
    ),
    dict(
        id="R07", company="Cedar Analytics", title="Data Engineer Intern",
        cycle="Summer 2027", category="SWE", location="New York, NY",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=7),
        sources={"greenhouse": [1, 2, 3, 4, 5, 6], "intern-list": [2, 4, 6]},
        requirements="sql|python|airflow|dbt",
        # A real relocation announced on day 4, from the authoritative source.
        # This one must mint a new version.
        location_from={4: "Remote - US"},
    ),
    dict(
        id="R08", company="Cedar Analytics", title="Machine Learning Intern",
        cycle="Summer 2027", category="ML/AI", location="New York, NY",
        grad=True, sponsorship="UNKNOWN", posted=day(1, 0) - timedelta(days=3),
        sources={"linkedin": [3, 4, 5], "community": [3, 4, 5, 6]},
        requirements="python|pytorch|sql",
    ),
    dict(
        id="R09", company="Delta Grid", title="Backend Engineer Intern",
        cycle="Summer 2027", category="SWE", location="Austin, TX",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=2),
        sources={"lever": [2, 3, 4, 5, 6], "intern-list": [2, 4, 6]},
        requirements="java|kubernetes|sql",
    ),
    dict(
        id="R10", company="Everline Health", title="Data Science Intern",
        cycle="Summer 2027", category="ML/AI", location="Boston, MA",
        grad=True, sponsorship="UNKNOWN", posted=day(1, 0) - timedelta(days=4),
        sources={"linkedin": [1, 3, 5], "community": [1, 2, 3, 4, 5, 6]},
        requirements="python|statistics|sql",
        # linkedin resolves "posted 2 days ago" against the wrong clock and
        # hands back a posted_at later than the moment it was observed. Left in
        # deliberately: the invariant test is supposed to see it.
        posted_overrides={"linkedin": day(1, 16)},
    ),
    dict(
        id="R11", company="Foxglove AI", title="Research Engineer Intern",
        cycle="Summer 2027", category="ML/AI", location="San Francisco, CA",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=10),
        sources={"ashby": [1, 2, 3, 4, 5, 6], "linkedin": [2, 4, 6],
                 "intern-list": [2, 4, 6]},
        requirements="python|pytorch|distributed systems|cuda",
        title_from={5: "Research Engineer Intern (PhD)"},
    ),
    dict(
        id="R12", company="Granite Trading", title="Quantitative Developer Intern",
        cycle="Summer 2027", category="Quant", location="Chicago, IL",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=8),
        sources={"ashby": [1, 2, 3, 4, 5, 6], "community": [3, 4, 5, 6]},
        requirements="c++|python|low latency", closed_from=5,
    ),
    dict(
        id="R13", company="Northwind Systems", title="Platform Engineer Intern",
        cycle="Fall 2026", category="SWE", location="New York, NY",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=12),
        sources={"greenhouse": [1, 2, 3, 4, 5, 6]},
        requirements="golang|kubernetes|terraform",
    ),
    dict(
        id="R14", company="Foxglove AI", title="Applied Scientist Intern",
        cycle="Summer 2027", category="ML/AI", location="San Francisco, CA",
        grad=True, sponsorship="SUPPORTED", posted=day(1, 0) - timedelta(days=1),
        sources={"ashby": [3, 4, 5, 6]},
        requirements="python|pytorch|machine learning|statistics",
    ),
]


def obs_id(source, source_job_id, observed, revision):
    raw = "%s|%s|%s|%d" % (source, source_job_id, iso(observed), revision)
    return "obs_" + hashlib.sha1(raw.encode()).hexdigest()[:16]


def build_observations():
    rows = []
    for r in REQS:
        ck = canonical_key(r["company"], r["title"], r["cycle"])
        for source in sorted(r["sources"]):
            sjid = "%s-%s" % (source, r["id"])
            for d in r["sources"][source]:
                observed = day(d, SOURCE_HOUR[source])
                title = r["title"]
                for from_day, new_title in sorted(r.get("title_from", {}).items()):
                    if d >= from_day:
                        title = new_title
                location = r.get("location_overrides", {}).get(source, r["location"])
                if source not in r.get("location_overrides", {}):
                    for from_day, new_loc in sorted(r.get("location_from", {}).items()):
                        if d >= from_day:
                            location = new_loc
                closed_from = r.get("closed_from")
                status = "CLOSED" if closed_from and d >= closed_from else "OPEN"
                posted = r.get("posted_overrides", {}).get(source, r["posted"])
                reqs = r["requirements"] if source in SOURCES_WITH_PROSE else ""
                rows.append(dict(
                    observation_id=obs_id(source, sjid, observed, 1),
                    batch_id=d,
                    source_name=source,
                    source_job_id=sjid,
                    revision=1,
                    observed_at=iso(observed),
                    posted_at=iso(posted),
                    ingested_at=iso(observed + timedelta(minutes=5)),
                    corrects_observation_id="",
                    correction_reason="",
                    company=r["company"],
                    title=title,
                    location=location,
                    cycle=r["cycle"],
                    category=r["category"],
                    posting_status=status,
                    sponsorship_status=r["sponsorship"],
                    graduation_eligible="true" if r["grad"] else "false",
                    requirements=reqs,
                    source_url="https://example.invalid/%s/%s" % (source, r["id"]),
                    canonical_key_hint=ck,
                ))
    return rows


def build_corrections(base):
    """Batch 7: the day-2 community list, re-read six days late.

    The community source is a version-controlled markdown list. On day 2 the
    parser hit a malformed table row, dropped everything after it and
    mis-recorded one status. Six days later the day-2 revision of that file is
    re-read from its own history and the repair is landed.

    Every repaired row carries observed_at = day 2, because day 2 is when the
    list said it. Only ingested_at is day 7. That is the whole shape of a late
    arriving correction, and it is what a max(observed_at) cursor cannot see.
    """
    by_key = {(r["source_name"], r["source_job_id"], r["observed_at"]): r for r in base}
    d2 = iso(day(2, SOURCE_HOUR["community"]))
    ing = iso(day(7, 9))
    out = []

    # C1: R05 was marked closed on the day-2 list. The parser read the row above
    # it. Restated as revision 2 of the same fetch.
    orig = by_key[("community", "community-R05", d2)]
    fixed = dict(orig)
    fixed.update(
        observation_id=obs_id("community", "community-R05", day(2, 6), 2),
        batch_id=7, revision=2, ingested_at=ing,
        corrects_observation_id=orig["observation_id"],
        correction_reason="day-2 list marked this closed; parser read the row above it",
        posting_status="CLOSED",
    )
    out.append(fixed)

    # C2 and C3: two rows that fell off the end of the day-2 parse entirely.
    # There is no earlier revision to restate, so these are first revisions of
    # fetches that were always supposed to exist.
    for rid, template_day in (("R08", 3), ("R12", 3)):
        src_job = "community-%s" % rid
        template = by_key[("community", src_job, iso(day(template_day, 6)))]
        row = dict(template)
        row.update(
            observation_id=obs_id("community", src_job, day(2, 6), 1),
            batch_id=7, revision=1,
            observed_at=d2, ingested_at=ing,
            corrects_observation_id="",
            correction_reason="dropped by the day-2 parse after a malformed table row",
            posting_status="OPEN",
        )
        out.append(row)
    return out


STATUS_EVENTS = [
    # (req id, from, to, day, hour, evidence)
    ("R01", "", "DISCOVERED", 1, 9, "first observation accepted by the pipeline"),
    ("R01", "DISCOVERED", "MIRRORED", 1, 12, "written to the tracker"),
    ("R01", "MIRRORED", "APPLIED_FLAGGED", 3, 20, "tracker checkbox set by hand"),
    ("R02", "", "DISCOVERED", 1, 9, "first observation accepted by the pipeline"),
    ("R02", "DISCOVERED", "MIRRORED", 2, 12, "written to the tracker"),
    ("R06", "", "DISCOVERED", 1, 11, "first observation accepted by the pipeline"),
    ("R06", "DISCOVERED", "MIRRORED", 1, 12, "written to the tracker"),
    ("R06", "MIRRORED", "APPLIED_FLAGGED", 2, 21, "tracker checkbox set by hand"),
    ("R06", "APPLIED_FLAGGED", "REJECTED_FLAGGED", 6, 18, "tracker status set to Rejected"),
    ("R07", "", "DISCOVERED", 1, 9, "first observation accepted by the pipeline"),
    ("R07", "DISCOVERED", "MIRRORED", 1, 12, "written to the tracker"),
    ("R07", "MIRRORED", "APPLIED_FLAGGED", 4, 19, "tracker checkbox set by hand"),
    ("R09", "", "DISCOVERED", 2, 10, "first observation accepted by the pipeline"),
    ("R09", "DISCOVERED", "MIRRORED", 2, 12, "written to the tracker"),
    ("R11", "", "DISCOVERED", 1, 11, "first observation accepted by the pipeline"),
    ("R11", "DISCOVERED", "MIRRORED", 1, 12, "written to the tracker"),
    ("R11", "MIRRORED", "APPLIED_FLAGGED", 2, 22, "tracker checkbox set by hand"),
    ("R13", "", "DISCOVERED", 1, 9, "first observation accepted by the pipeline"),
    ("R13", "DISCOVERED", "MIRRORED", 3, 12, "written to the tracker"),
    ("R14", "", "DISCOVERED", 3, 11, "first observation accepted by the pipeline"),
    ("R14", "DISCOVERED", "MIRRORED", 3, 12, "written to the tracker"),
]


def build_status_events():
    by_id = {r["id"]: r for r in REQS}
    rows = []
    for i, (rid, frm, to, d, hour, evidence) in enumerate(STATUS_EVENTS, start=1):
        r = by_id[rid]
        recorded = day(d, hour)
        rows.append(dict(
            event_id="evt_%04d" % i,
            batch_id=d,
            canonical_key=canonical_key(r["company"], r["title"], r["cycle"]),
            from_status=frm,
            to_status=to,
            recorded_at=iso(recorded),
            ingested_at=iso(recorded + timedelta(minutes=5)),
            evidence=evidence,
        ))
    return rows


def write(path, rows, fields):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(row)


def main():
    base = build_observations()
    obs = base + build_corrections(base)
    obs.sort(key=lambda r: (r["batch_id"], r["observed_at"], r["source_name"],
                            r["source_job_id"], r["revision"]))
    obs_fields = ["observation_id", "batch_id", "source_name", "source_job_id",
                  "revision", "observed_at", "posted_at", "ingested_at",
                  "corrects_observation_id", "correction_reason", "company",
                  "title", "location", "cycle", "category", "posting_status",
                  "sponsorship_status", "graduation_eligible", "requirements",
                  "source_url", "canonical_key_hint"]
    write(os.path.join(OUT, "source_observations.csv"), obs, obs_fields)

    evt = build_status_events()
    evt_fields = ["event_id", "batch_id", "canonical_key", "from_status",
                  "to_status", "recorded_at", "ingested_at", "evidence"]
    write(os.path.join(OUT, "application_status_events.csv"), evt, evt_fields)

    print("source_observations.csv rows: %d (batches 1-6: %d, correction batch 7: %d)"
          % (len(obs), len(base), len(obs) - len(base)))
    print("application_status_events.csv rows: %d" % len(evt))


if __name__ == "__main__":
    main()
