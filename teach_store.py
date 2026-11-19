#!/usr/bin/env python3
"""TEACH_HALO_09NOV2026 (COO directive 9 Nov 2026).

Storage side of the staff "teach Halo" command on the admin WhatsApp bot.

Staff send "teach: <question> | <answer>" to the 0812 bot. The note lands here
as a DRAFT in Honourworld.halo_teach_drafts (status pending). Nothing Halo reads
changes until John or Bukunmi reply "approve T-<n>", at which point the draft is
copied into n8n.Faqs, the live knowledge base Halo searches (source
"staff_teach"). Rejected or fixed drafts never touch the live store.

Called by teach.js: one JSON request on stdin, one JSON reply on stdout.
Reads MONGO_URL from the environment (the bot passes the retry-box config value).
"""
import datetime
import json
import os
import sys

from pymongo import MongoClient, ReturnDocument

SEQ_ID = "__seq"
BILLER_WORDS = ("mdollas", "vtuplug", "ringo", "merrybills", "autosync", "cash2bill", "a2c", "palmpay")


def _now():
    return datetime.datetime.utcnow()


def _public(d):
    if not d:
        return None
    return {
        "id": d.get("tid"),
        "question": d.get("question", ""),
        "answer": d.get("answer", ""),
        "status": d.get("status"),
        "created_by": d.get("created_by"),
        "created_phone": d.get("created_phone"),
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
        "approved_by": d.get("approved_by"),
        "rejected_by": d.get("rejected_by"),
        "reason": d.get("reason"),
    }


def _norm(tid):
    digits = "".join(ch for ch in str(tid or "") if ch.isdigit())
    return "T-%s" % digits if digits else str(tid or "").upper()


def _find(drafts, tid):
    return drafts.find_one({"tid": _norm(tid)})


def _similar(faqs, text, limit=2):
    try:
        rows = faqs.find({"$text": {"$search": text}}, {"_id": 0, "question": 1, "answer": 1, "score": {"$meta": "textScore"}}) \
                   .sort([("score", {"$meta": "textScore"})]).limit(limit)
        return [{"question": r.get("question", ""), "answer": str(r.get("answer", ""))[:160]} for r in rows]
    except Exception:
        return []


def main():
    req = json.load(sys.stdin)
    op = req.get("op")
    url = os.environ.get("MONGO_URL") or ""
    if not url:
        print(json.dumps({"ok": False, "error": "MONGO_URL not set"}))
        return
    client = MongoClient(url, serverSelectionTimeoutMS=8000, connectTimeoutMS=8000, socketTimeoutMS=15000)
    main_db = client.get_default_database()
    drafts = main_db.halo_teach_drafts
    faqs = client["n8n"].Faqs
    now = _now()
    out = {"ok": True}

    if op == "create":
        q = str(req.get("question") or "").strip()
        a = str(req.get("answer") or "").strip()
        if len(a) < 10:
            out = {"ok": False, "error": "answer too short"}
        else:
            seq = drafts.find_one_and_update({"_id": SEQ_ID}, {"$inc": {"n": 1}}, upsert=True, return_document=ReturnDocument.AFTER)
            tid = "T-%d" % int(seq.get("n", 1))
            doc = {
                "tid": tid, "question": q, "answer": a, "raw": str(req.get("raw") or "")[:2000],
                "status": "pending",
                "created_by": req.get("by_name") or "", "created_phone": req.get("by_phone") or "",
                "created_at": now, "updated_at": now,
            }
            drafts.insert_one(doc)
            out = {"ok": True, "draft": _public(doc), "similar": _similar(faqs, q + " " + a)}

    elif op == "list":
        rows = list(drafts.find({"status": "pending"}).sort("created_at", 1).limit(20))
        out = {"ok": True, "drafts": [_public(r) for r in rows]}

    elif op == "get":
        out = {"ok": True, "draft": _public(_find(drafts, req.get("id")))}

    elif op in ("approve", "reject", "fix"):
        d = _find(drafts, req.get("id"))
        if not d:
            out = {"ok": False, "error": "no draft %s" % req.get("id")}
        elif d.get("status") != "pending":
            out = {"ok": False, "error": "%s is already %s" % (d["tid"], d.get("status")), "draft": _public(d)}
        elif op == "approve":
            faq = {
                "question": d["question"], "answer": d["answer"],
                "source": "staff_teach",
                "note": "Taught by %s on the admin WhatsApp bot (%s), approved by %s" % (d.get("created_by") or "staff", d["tid"], req.get("by_name") or "leadership"),
                "createdAt": now, "updatedAt": now,
            }
            r = faqs.insert_one(faq)
            d2 = drafts.find_one_and_update(
                {"tid": d["tid"], "status": "pending"},
                {"$set": {"status": "approved", "approved_by": req.get("by_name") or "", "approved_phone": req.get("by_phone") or "",
                          "approved_at": now, "updated_at": now, "faq_id": r.inserted_id}},
                return_document=ReturnDocument.AFTER)
            out = {"ok": True, "draft": _public(d2), "faq_id": str(r.inserted_id)}
        elif op == "reject":
            d2 = drafts.find_one_and_update(
                {"tid": d["tid"], "status": "pending"},
                {"$set": {"status": "rejected", "rejected_by": req.get("by_name") or "", "rejected_phone": req.get("by_phone") or "",
                          "reason": str(req.get("reason") or "")[:300], "rejected_at": now, "updated_at": now}},
                return_document=ReturnDocument.AFTER)
            out = {"ok": True, "draft": _public(d2)}
        else:  # fix
            upd = {"updated_at": now, "fixed_by": req.get("by_name") or ""}
            if req.get("question"):
                upd["question"] = str(req["question"]).strip()
            if req.get("answer"):
                upd["answer"] = str(req["answer"]).strip()
            d2 = drafts.find_one_and_update({"tid": d["tid"], "status": "pending"}, {"$set": upd}, return_document=ReturnDocument.AFTER)
            out = {"ok": True, "draft": _public(d2)}

    elif op == "purge_test":  # used only by the deploy self-test; removes what it created
        tid = req.get("id")
        d = _find(drafts, tid)
        n_faq = 0
        if d and d.get("faq_id") is not None:
            n_faq = faqs.delete_one({"_id": d["faq_id"], "source": "staff_teach"}).deleted_count
        n = drafts.delete_one({"tid": _norm(tid), "created_phone": "self-test"}).deleted_count
        out = {"ok": True, "deleted_drafts": n, "deleted_faqs": n_faq}
    else:
        out = {"ok": False, "error": "unknown op %r" % op}

    client.close()
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # always answer the bot with JSON
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
