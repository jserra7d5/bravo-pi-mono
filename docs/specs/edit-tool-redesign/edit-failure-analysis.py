#!/usr/bin/env python3
"""Analyze pi-agent edit failures vs. whether content was surfaced beforehand."""
import json, glob, re, os
from collections import Counter, defaultdict

SESS_DIR = "/home/joe/.pi/agent/sessions"
files = sorted(glob.glob(os.path.join(SESS_DIR, "*/*.jsonl")))

def get_text(m):
    t = m.get("content")
    if isinstance(t, list):
        return " ".join(x.get("text", "") for x in t if isinstance(x, dict))
    return str(t) if t is not None else ""

def norm_ws(s):
    return re.sub(r"\s+", " ", s).strip()

# non-read, non-edit tools whose output "surfaces" file content
SURFACE_TOOLS = {"ranked_search", "grep", "find", "ls", "bash", "web_fetch",
                 "web_search", "web_lookup", "read"}  # read handled separately

# Totals
edit_calls = 0
edit_fail = 0
fail_cat = Counter()

# Per-failed-edit records
records = []  # dict per failed not_found/not_unique edit

for path in files:
    try:
        fh = open(path)
    except Exception:
        continue

    # accumulators (reset per session)
    call_by_id = {}                       # toolCallId -> {name, arguments}
    read_text_by_path = defaultdict(list) # exact path -> list of read result texts (successful)
    read_text_by_base = defaultdict(list) # basename -> list of texts
    read_paths = set()                    # exact paths read ok
    read_bases = set()
    write_paths = set()                   # exact paths written
    other_results = []                    # list of (toolname, text) for surface tools (non-read)
    ranked_search_count = 0               # ranked_search calls seen so far
    ranked_search_texts = []              # ranked_search result texts so far
    success_edit_paths = set()            # paths with a prior successful edit (file mutated since read)

    for line in fh:
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
                                                   "arguments": b.get("arguments")}
                        if b.get("name") == "ranked_search":
                            ranked_search_count += 1
            continue

        if role != "toolResult":
            continue

        tn = m.get("toolName")
        cid = m.get("toolCallId")
        is_err = bool(m.get("isError"))
        call = call_by_id.get(cid, {})
        args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}

        # ----- handle the result of each tool to update accumulators -----
        if tn == "read":
            if not is_err:
                p = args.get("path") or args.get("file")
                txt = get_text(m)
                if p:
                    read_text_by_path[p].append(txt)
                    read_text_by_base[os.path.basename(p)].append(txt)
                    read_paths.add(p)
                    read_bases.add(os.path.basename(p))
        elif tn == "write":
            if not is_err:
                p = args.get("path") or args.get("file")
                if p:
                    write_paths.add(p)
        elif tn == "ranked_search":
            if not is_err:
                ranked_search_texts.append(get_text(m))
        elif tn in SURFACE_TOOLS:
            if not is_err:
                other_results.append((tn, get_text(m)))

        # ----- when an EDIT result comes in -----
        if tn == "edit":
            edit_calls += 1
            if not is_err:
                # success: mark path as mutated
                p = args.get("path")
                if p:
                    success_edit_paths.add(p)
                continue
            # failure:
            edit_fail += 1
            etext = get_text(m)
            if "Could not find" in etext:
                cat = "not_found"
            elif "occurrences" in etext and "unique" in etext:
                cat = "not_unique"
            elif "No such file" in etext or "ENOENT" in etext:
                cat = "no_file"
            else:
                cat = "other"
            fail_cat[cat] += 1
            if cat not in ("not_found", "not_unique"):
                continue

            p = args.get("path")
            # which sub-edit failed?
            mobj = re.search(r"edits\[(\d+)\]", etext)
            old = None
            if mobj and isinstance(args.get("edits"), list):
                idx = int(mobj.group(1))
                if 0 <= idx < len(args["edits"]):
                    old = args["edits"][idx].get("oldText")
            if old is None and isinstance(args.get("edits"), list) and args["edits"]:
                old = args["edits"][0].get("oldText")
            old = old or ""
            old_n = norm_ws(old)
            # longest meaningful line of oldText (for loose 'core line' match)
            core = max((ln for ln in old.splitlines()), key=len, default="")
            core_n = norm_ws(core)

            # --- signals ---
            path_read = p in read_paths
            base_read = (os.path.basename(p) in read_bases) if p else False

            # verbatim region read: failing oldText present in a prior read of THIS path
            region_read_exact = False
            region_read_ws = False
            if p and old:
                for txt in read_text_by_path.get(p, []):
                    if old and old in txt:
                        region_read_exact = True; break
                if not region_read_exact:
                    for txt in read_text_by_path.get(p, []):
                        if old_n and old_n in norm_ws(txt):
                            region_read_ws = True; break
            # core-line in a prior read of this path (loose)
            core_in_read = False
            if p and core_n and len(core_n) >= 12:
                for txt in read_text_by_path.get(p, []):
                    if core_n in norm_ws(txt):
                        core_in_read = True; break

            # surfaced via ranked_search (path or oldText/core in a prior RS result)
            rs_hit = False
            for txt in ranked_search_texts:
                if (p and p in txt) or (old and old in txt) or (core_n and len(core_n) >= 12 and core_n in norm_ws(txt)):
                    rs_hit = True; break

            # surfaced via any other (non-read) tool: oldText/core or path in output
            other_hit = False
            for tname, txt in other_results:
                if (old and old in txt) or (core_n and len(core_n) >= 12 and core_n in norm_ws(txt)):
                    other_hit = True; break
            written = p in write_paths
            mutated_since_read = p in success_edit_paths

            records.append(dict(
                cat=cat, path=p,
                path_read=path_read, base_read=base_read,
                region_read_exact=region_read_exact,
                region_read_ws=region_read_ws,
                core_in_read=core_in_read,
                rs_count_before=ranked_search_count,
                rs_hit=rs_hit, other_hit=other_hit,
                written=written, mutated_since_read=mutated_since_read,
            ))

    fh.close()

# ---------------- REPORT ----------------
succ = edit_calls - edit_fail
print("="*64)
print("OVERALL EDIT STATS (all pi sessions)")
print("="*64)
print(f"  edit tool calls : {edit_calls}")
print(f"  succeeded       : {succ}")
print(f"  failed          : {edit_fail}")
print(f"  SUCCESS RATE    : {100*succ/edit_calls:.2f}%")
print(f"  failure rate    : {100*edit_fail/edit_calls:.2f}%")
print()
print("  failure taxonomy:")
for k, v in fail_cat.most_common():
    print(f"    {k:12s} {v:4d}  ({100*v/edit_fail:.1f}% of failures)")

def report(recs, title):
    n = len(recs)
    if n == 0:
        return
    print()
    print("="*64)
    print(f"{title}  (n={n})")
    print("="*64)
    # mutually-exclusive buckets, priority order
    b_proper = b_filenotpart = b_surfaced = b_blind = 0
    for r in recs:
        if r["region_read_exact"] or r["region_read_ws"]:
            b_proper += 1
        elif r["path_read"]:
            b_filenotpart += 1
        elif r["rs_hit"] or r["other_hit"] or r["written"]:
            b_surfaced += 1
        else:
            b_blind += 1
    def pct(x): return f"{100*x/n:.1f}%"
    print("MUTUALLY-EXCLUSIVE BUCKETS (priority order):")
    print(f"  1. Read the PROPER PART first (failing oldText was in a prior read of that file)")
    print(f"        {b_proper:4d}  {pct(b_proper)}")
    print(f"  2. Read the file but NOT the proper part (file read; failing text never in a read)")
    print(f"        {b_filenotpart:4d}  {pct(b_filenotpart)}")
    print(f"  3. Did NOT read the file, but content surfaced via ranked_search/other/write")
    print(f"        {b_surfaced:4d}  {pct(b_surfaced)}")
    print(f"  4. BLIND edit - file never read, content never surfaced by any tool")
    print(f"        {b_blind:4d}  {pct(b_blind)}")
    # raw (non-exclusive) signals
    pr = sum(r["path_read"] for r in recs)
    rex = sum(r["region_read_exact"] for r in recs)
    rws = sum(r["region_read_exact"] or r["region_read_ws"] for r in recs)
    cir = sum(r["core_in_read"] for r in recs)
    rsany = sum(r["rs_count_before"] > 0 for r in recs)
    rshit = sum(r["rs_hit"] for r in recs)
    oth = sum(r["other_hit"] for r in recs)
    wr = sum(r["written"] for r in recs)
    mut = sum(r["mutated_since_read"] for r in recs)
    print("\nRAW SIGNALS (overlapping):")
    print(f"  target file was read at all before edit : {pr:4d}  {pct(pr)}")
    print(f"  failing oldText verbatim in prior read  : {rex:4d}  {pct(rex)}")
    print(f"  failing oldText in prior read (ws-loose): {rws:4d}  {pct(rws)}")
    print(f"  core line of oldText in prior read      : {cir:4d}  {pct(cir)}")
    print(f"  a ranked_search ran before edit         : {rsany:4d}  {pct(rsany)}")
    print(f"  ranked_search surfaced path/oldText     : {rshit:4d}  {pct(rshit)}")
    print(f"  other tool (grep/bash/etc) surfaced it  : {oth:4d}  {pct(oth)}")
    print(f"  agent had WRITTEN the file this session : {wr:4d}  {pct(wr)}")
    print(f"  file had a prior SUCCESSFUL edit (mutated since read): {mut:4d}  {pct(mut)}")

report(records, "FAILED EDITS (not_found + not_unique)")
report([r for r in records if r["cat"]=="not_found"], "  -> only NOT_FOUND failures (oldText didn't match)")
report([r for r in records if r["cat"]=="not_unique"], "  -> only NOT_UNIQUE failures (ambiguous match)")
