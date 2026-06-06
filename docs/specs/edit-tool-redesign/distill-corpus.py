#!/usr/bin/env python3
"""
Distill the pi-agent session corpus (~470MB) into a small self-contained replay fixture.

ZERO LLM tokens. Run by hand. Output: fixtures/edit-cases.jsonl

For every `edit` tool call we emit one record with:
  - the edit arguments (path, edits[])
  - outcome (success/fail) + parsed error_type / failing edit index / error_text
  - reconstructed edit-time file content: the nearest preceding successful `read` of that path in the
    same session, ROLLED FORWARD through any intervening successful edits to that path (best-effort,
    plain replace) so the "mutated since read" cohort is reconstructed, not stale.
  - fidelity flags so the harness can stratify results by how trustworthy the reconstruction is.

Inclusion: ALL failures; successes only if they look fuzzy-relevant (failing exact match against the
reconstruction) OR a deterministic 1-in-8 sample (regression control). Keeps the fixture small.
"""
import json, glob, re, os, hashlib

SESS = "/home/joe/.pi/agent/sessions"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
OUT = os.path.join(OUT_DIR, "edit-cases.jsonl")
CAP = 262144  # cap reconstructed content per record (chars)

os.makedirs(OUT_DIR, exist_ok=True)

def get_text(m):
    c = m.get("content")
    if isinstance(c, list):
        return "".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return c if isinstance(c, str) else ""

def lf(s):
    return s.replace("\r\n", "\n").replace("\r", "\n")

def classify(err):
    if "Could not find" in err: return "not_found"
    if "occurrences" in err and "unique" in err: return "not_unique"
    if "overlap" in err: return "overlap"
    if "must not be empty" in err: return "empty"
    if "identical content" in err: return "no_change"
    return "other"

def apply_success(content, edits):
    """Best-effort roll-forward: apply a successful edit's replacements to reconstructed content."""
    dirty = False
    cur = content
    for e in edits:
        if not isinstance(e, dict): continue
        o = lf(str(e.get("oldText", ""))); n = lf(str(e.get("newText", "")))
        if not o:
            continue
        idx = cur.find(o)
        if idx == -1:
            dirty = True
            continue
        cur = cur[:idx] + n + cur[idx + len(o):]
    return cur, dirty

files = sorted(glob.glob(os.path.join(SESS, "*/*.jsonl")))
n_records = 0
stats = {"fail": 0, "success_emitted": 0, "fail_recon": 0, "fail_no_recon": 0,
         "fail_recon_dirty": 0, "by_err": {}}

with open(OUT, "w") as out:
    for path in files:
        try:
            fh = open(path)
        except Exception:
            continue
        sess = os.path.relpath(path, SESS)
        call_by_id = {}
        # per-path reconstructed "current" content (last read, rolled forward through successes)
        cur_content = {}      # path -> str
        cur_windowed = {}     # path -> bool (last read used offset/limit)
        cur_dirty = {}        # path -> bool (a roll-forward replace missed)
        success_paths = set() # paths with a prior successful edit this session
        line_idx = -1
        for line in fh:
            line_idx += 1
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") != "message":
                continue
            m = o["message"]
            role = m.get("role")

            if role == "assistant":
                c = m.get("content")
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict) and b.get("type") == "toolCall":
                            call_by_id[b.get("id")] = {"name": b.get("name"),
                                                       "arguments": b.get("arguments") if isinstance(b.get("arguments"), dict) else {}}
                continue
            if role != "toolResult":
                continue

            tn = m.get("toolName")
            cid = m.get("toolCallId")
            is_err = bool(m.get("isError"))
            call = call_by_id.get(cid, {})
            args = call.get("arguments", {}) if isinstance(call.get("arguments"), dict) else {}

            if tn == "read" and not is_err:
                p = args.get("path") or args.get("file")
                if p:
                    cur_content[p] = lf(get_text(m))
                    cur_windowed[p] = ("offset" in args) or ("limit" in args)
                    cur_dirty[p] = False
                continue

            if tn != "edit":
                continue

            p = args.get("path")
            edits = args.get("edits") if isinstance(args.get("edits"), list) else []
            recon = cur_content.get(p)
            recon_present = recon is not None
            recon_windowed = bool(cur_windowed.get(p, False))
            recon_dirty = bool(cur_dirty.get(p, False))
            prior_succ = p in success_paths

            # failing edit index + first/zeroth oldText for the exact-in-recon check
            outcome = "fail" if is_err else "success"
            error_text = get_text(m) if is_err else None
            err_type = classify(error_text) if is_err else None
            fail_idx = None
            if is_err:
                mo = re.search(r"edits\[(\d+)\]", error_text or "")
                if mo:
                    fail_idx = int(mo.group(1))
            probe_idx = fail_idx if (fail_idx is not None and 0 <= fail_idx < len(edits)) else 0
            probe_old = lf(str(edits[probe_idx].get("oldText", ""))) if edits and isinstance(edits[probe_idx], dict) else ""
            exact_in_recon = (probe_old in recon) if (recon_present and probe_old) else None

            # decide whether to emit this record
            emit = False
            if is_err:
                emit = True
            else:
                # successes: keep fuzzy-suspects (exact probe not found in recon) + 1-in-8 sample
                if recon_present and exact_in_recon is False:
                    emit = True
                elif (line_idx % 8) == 0:
                    emit = True

            if emit:
                truncated = False
                rc = recon
                if rc is not None and len(rc) > CAP:
                    rc = rc[:CAP]; truncated = True
                rec = {
                    "case_id": f"{os.path.basename(path)}#{line_idx}",
                    "session": sess,
                    "path": p,
                    "outcome": outcome,
                    "error_type": err_type,
                    "fail_edit_index": fail_idx,
                    "error_text": error_text,
                    "edits": edits,
                    "recon_content": rc,
                    "recon_present": recon_present,
                    "recon_windowed": recon_windowed,
                    "recon_rolled_forward": prior_succ,   # had a prior successful edit on this path
                    "recon_dirty": recon_dirty,           # a roll-forward replace missed -> lower fidelity
                    "recon_truncated": truncated,
                    "exact_oldtext_in_recon": exact_in_recon,
                }
                out.write(json.dumps(rec) + "\n")
                n_records += 1
                if is_err:
                    stats["fail"] += 1
                    stats["by_err"][err_type] = stats["by_err"].get(err_type, 0) + 1
                    if recon_present: stats["fail_recon"] += 1
                    else: stats["fail_no_recon"] += 1
                    if recon_dirty: stats["fail_recon_dirty"] += 1
                else:
                    stats["success_emitted"] += 1

            # update rolling state AFTER recording (this edit is the reconstruction point)
            if not is_err:
                success_paths.add(p)
                if recon is not None:
                    rolled, d = apply_success(recon, edits)
                    cur_content[p] = rolled
                    if d: cur_dirty[p] = True
        fh.close()

size = os.path.getsize(OUT)
print(f"wrote {OUT}")
print(f"  records: {n_records}  ({size/1048576:.2f} MB)")
print(f"  failures emitted: {stats['fail']}  by type: {stats['by_err']}")
print(f"  failures with reconstructed content: {stats['fail_recon']}  "
      f"(no recon: {stats['fail_no_recon']}, dirty roll-forward: {stats['fail_recon_dirty']})")
print(f"  successes emitted (correctness/regression sample): {stats['success_emitted']}")
