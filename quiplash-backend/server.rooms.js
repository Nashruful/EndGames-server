import "dotenv/config";
// server.rooms.js
// Minimal /rooms API to match Unity QuiplashGameManager.cs (polling + ownerToken start)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

function makeRoomCode(len = 4) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function makeOwnerToken() {
    return crypto.randomBytes(16).toString("hex");
}

function toUnixSeconds(date) {
    return Math.floor(new Date(date).getTime() / 1000);
}

function nowIso() {
    return new Date().toISOString();
}

// ─── Simple in-memory cache with TTL ───────────────────────────
const _cache = new Map();

function cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) { _cache.delete(key); return undefined; }
    return e.val;
}

function cacheSet(key, val, ttlMs) {
    _cache.set(key, { val, exp: Date.now() + ttlMs });
}

function cacheInvalidate(prefix) {
    for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

function cacheInvalidateRoom() {
    _cache.clear();
}
// ────────────────────────────────────────────────────────────────

async function getRoomByCode(code, skipCache = false) {
    const key = `room:${code}`;
    if (!skipCache) {
        const c = cacheGet(key);
        if (c) return JSON.parse(JSON.stringify(c));
    }
    const { data, error } = await supabase
        .from("rooms")
        .select("id, code, owner_token, host_player_id, max_players, started, state, active_prompt_index, reveal_deadline, leaderboard_deadline, intro_deadline, created_at")
        .eq("code", code)
        .maybeSingle();
    if (error) throw error;
    if (data) cacheSet(key, JSON.parse(JSON.stringify(data)), 1000);
    return data;
}

async function getPlayers(roomId) {
    const key = `players:${roomId}`;
    const c = cacheGet(key);
    if (c) return c;

    const { data, error } = await supabase
        .from("room_players")
        .select("id, display_name, joined_at, seat")
        .eq("room_id", roomId)
        .order("seat", { ascending: true, nullsFirst: false })
        .order("joined_at", { ascending: true });

    if (error) throw error;

    const result = (data || []).map((p) => ({
        id: p.id,
        name: p.display_name || "Player",
    }));
    cacheSet(key, result, 10000);
    return result;
}

async function getActiveRound(roomId) {
    const key = `activeRound:${roomId}`;
    const c = cacheGet(key);
    if (c) return c;

    const { data, error } = await supabase
        .from("rounds")
        .select("id, number, state, created_at")
        .eq("room_id", roomId)
        .order("number", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (data) cacheSet(key, data, 5000);
    return data;
}

async function getActiveRoundPrompt(roundId, skipCache = false) {
    const key = `activeRoundPrompt:${roundId}`;
    if (!skipCache) {
        const c = cacheGet(key);
        if (c) return JSON.parse(JSON.stringify(c));
    }

    const { data, error } = await supabase
        .from("round_prompts")
        .select("id, state, answer_deadline, vote_deadline, order_index, prompt_id, player1_id, player2_id")
        .eq("round_id", roundId)
        .neq("state", "done")
        .order("order_index", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (data) cacheSet(key, JSON.parse(JSON.stringify(data)), 2000);
    return data;
}


async function getPromptText(promptId) {
    const key = `promptText:${promptId}`;
    const c = cacheGet(key);
    if (c) return c;

    const { data, error } = await supabase
        .from("prompts")
        .select("text")
        .eq("id", promptId)
        .maybeSingle();

    if (error) throw error;
    const text = data?.text || "";
    cacheSet(key, text, 600000);
    return text;
}

function categoryForRound(roundNumber) {
    if (roundNumber === 1) return "round1";
    if (roundNumber === 2) return "round2";
    return "round3";
}

// Fetch N prompts for a given round category, excluding promptIds already used in this room
async function getPromptsForRound(roomId, roundNumber, count) {
    const category = categoryForRound(roundNumber);

    // 1) get used prompt ids for this room so we don�t repeat
    const { data: usedRows, error: usedErr } = await supabase
        .from("round_prompts")
        .select("prompt_id, rounds!inner(room_id)")
        .eq("rounds.room_id", roomId);

    if (usedErr) throw usedErr;

    const used = new Set((usedRows || []).map(r => r.prompt_id));

    // 2) pull a pool from this category then pick randomly in JS
    const { data: pool, error: poolErr } = await supabase
        .from("prompts")
        .select("id")
        .eq("category", category)
        .limit(50);

    if (poolErr) throw poolErr;

    const filtered = (pool || []).map(p => p.id).filter(id => !used.has(id));

    if (filtered.length < count) return null;

    // shuffle
    for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }

    return filtered.slice(0, count);
}

async function startRound(room, roundNumber) {
    const players = await getPlayers(room.id);
    if (players.length < 4) throw new Error("not_enough_players");

    // Shuffle players each round (simple random)
    const shuffledPlayers = [...players].sort(() => Math.random() - 0.5);

    // Create the round
    const { data: round, error: rErr } = await supabase
        .from("rounds")
        .insert({
            room_id: room.id,
            number: roundNumber,
            state: "active",
            created_at: nowIso(),
        })
        .select("id, number")
        .single();

    if (rErr) throw rErr;

    // Two matchups: (0 vs 1), (2 vs 3)
    const matchups = [
        [shuffledPlayers[0].id, shuffledPlayers[1].id],
        [shuffledPlayers[2].id, shuffledPlayers[3].id],
    ];

    // Prompts by category: round1/round2/round3
    const prompts = await getPromptsForRound(room.id, roundNumber, 2);
    const isTripleMode = roundNumber === 3;
    if (!prompts || prompts.length < 2) throw new Error("not_enough_prompts_for_round");

    // Timers
    const answerSeconds = 15;
    const voteSeconds = 90;

    const now = Date.now();
    const answerDeadline = new Date(now + answerSeconds * 1000).toISOString();
    const voteDeadline = new Date(now + (answerSeconds + voteSeconds) * 1000).toISOString();

    for (let i = 0; i < matchups.length; i++) {
        const [player1_id, player2_id] = matchups[i];

        const { error: rpErr } = await supabase.from("round_prompts").insert({
            round_id: round.id,
            prompt_id: prompts[i],
            player1_id,
            player2_id,
            order_index: i,
            state: "answering",
            answer_deadline: answerDeadline,
            vote_deadline: voteDeadline,
            created_at: nowIso(),
        });

        if (rpErr) throw rpErr;
    }

    // Intro phase before answering_all (placeholder: reuse Round 1 intro length)
    const introSeconds = 120;
    const introDeadline = new Date(Date.now() + introSeconds * 1000).toISOString();

    const { error: uErr } = await supabase
        .from("rooms")
        .update({
            started: true,
            state: "round_intro",
            active_prompt_index: 0,
            intro_deadline: introDeadline,
            leaderboard_deadline: null,
            reveal_deadline: null,
        })
        .eq("id", room.id);

    if (uErr) throw uErr;

    return { roundId: round.id, roundNumber: round.number };
}



async function activateNextPrompt(roundId, currentOrderIndex, roomId) {
    // next prompt by order_index
    const nextIndex = currentOrderIndex + 1;

    const { data: nextRp, error: nErr } = await supabase
        .from("round_prompts")
        .select("id")
        .eq("round_id", roundId)
        .eq("order_index", nextIndex)
        .maybeSingle();

    if (nErr) throw nErr;

    // No more prompts -> leaderboard phase (auto-advance to next round)
    if (!nextRp) {
        const leaderboardSeconds = 10;
        const leaderboardDeadline = new Date(Date.now() + leaderboardSeconds * 1000).toISOString();

        const { error: rErr } = await supabase
            .from("rooms")
            .update({
                state: "leaderboard",
                leaderboard_deadline: leaderboardDeadline,
                reveal_deadline: null,
                intro_deadline: null,
            })
            .eq("id", roomId);

        if (rErr) throw rErr;
        return { advanced: false, to: "leaderboard" };
    }


    // Move room to reveal for the NEXT prompt
    const revealSeconds = 10;
    const revealDeadline = new Date(Date.now() + revealSeconds * 1000).toISOString();

    const { error: roomErr } = await supabase
        .from("rooms")
        .update({
            state: "reveal",
            active_prompt_index: nextIndex,
            reveal_deadline: revealDeadline
        })
        .eq("id", roomId);

    if (roomErr) throw roomErr;

    return { advanced: true, to: "reveal", index: nextIndex };
}



/**
 * POST /rooms
 * Creates a room only. Does NOT create a player.
 * Returns: { success, code }
 */
app.post("/rooms", async (req, res) => {
    try {
        let code = makeRoomCode(4);
        for (let i = 0; i < 5; i++) {
            const existing = await getRoomByCode(code);
            if (!existing) break;
            code = makeRoomCode(4);
        }

        const { data: room, error: roomErr } = await supabase
            .from("rooms")
            .insert({
                code,
                owner: null,
                owner_token: null,
                max_players: 4,
                started: false,
                state: "lobby",
                host_player_id: null,
                created_at: nowIso(),
            })
            .select("id, code")
            .single();

        if (roomErr) throw roomErr;

        console.log(`[rooms] created room ${code}`);
        res.json({ success: true, code: room.code });
    } catch (e) {
        console.error("POST /rooms error:", e);
        res.status(500).json({ success: false, error: "create_room_failed" });
    }
});



/**
 * GET /rooms/:code
 * Returns RoomStatusResponse expected by Unity:
 * { success, phase, players: [{id,name,answer,votes}], started, currentRound, phaseEndTimestamp }
 */
app.get("/rooms/:code", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const room = await getRoomByCode(code, true); // skip cache — polling reads fresh state
        if (!room) return res.status(404).json({ success: false });

        // Parallelize independent queries (both only need room.id)
        const [playersBasic, activeRound] = await Promise.all([
            getPlayers(room.id),
            getActiveRound(room.id),
        ]);

        // Defaults for lobby
        let phase = room.state || "lobby";
        let started = !!room.started;
        let currentRound = 0;
        let phaseEndTimestamp = 0;

        let players = playersBasic.map((p) => ({ ...p, answer: "", votes: 0 }));

        // -----------------------------
        // AUTO: leaderboard -> round_intro(next) OR end game
        // AUTO: round_intro -> answering_all
        // -----------------------------
        {
            const now = Date.now();

            // round_intro auto -> answering_all
            if (room.started && room.state === "round_intro" && room.intro_deadline) {
                const introMs = new Date(room.intro_deadline).getTime();
                if (now > introMs) {
                    await supabase
                        .from("rooms")
                        .update({ state: "answering_all", intro_deadline: null })
                        .eq("id", room.id);

                    // refresh local room.state (so response is correct in this same request)
                    room.state = "answering_all";
                }
            }

            // post_vote_pause auto -> next reveal/leaderboard
            if (room.started && room.state === "post_vote_pause" && room.reveal_deadline) {
                const pauseMs = new Date(room.reveal_deadline).getTime();
                if (now > pauseMs) {
                    // clear pause deadline first (race-safe)
                    const { data: cleared, error: cErr } = await supabase
                        .from("rooms")
                        .update({ reveal_deadline: null })
                        .eq("id", room.id)
                        .eq("state", "post_vote_pause")
                        .select("id");

                    if (cErr) throw cErr;

                    // If we didn't actually clear (someone else did), do nothing
                    if (cleared && cleared.length > 0) {
                        const active = await getActiveRound(room.id);
                        if (active) {
                            const idx = Number.isInteger(room.active_prompt_index) ? room.active_prompt_index : 0;
                            await activateNextPrompt(active.id, idx, room.id);
                        }
                    }

                    // refresh local room state for correct response in this same request
                    const refreshed = await getRoomByCode(code, true);
                    if (refreshed) {
                        room.state = refreshed.state;
                        room.active_prompt_index = refreshed.active_prompt_index;
                        room.reveal_deadline = refreshed.reveal_deadline;
                        room.leaderboard_deadline = refreshed.leaderboard_deadline;
                        room.intro_deadline = refreshed.intro_deadline;
                    }
                }
            }


            // leaderboard auto -> next round intro (or results if round 3 finished)
            if (room.started && room.state === "leaderboard" && room.leaderboard_deadline) {
                const lbMs = new Date(room.leaderboard_deadline).getTime();
                if (now > lbMs) {

                    // Prevent multiple transitions by clearing deadline immediately
                    await supabase
                        .from("rooms")
                        .update({ leaderboard_deadline: null })
                        .eq("id", room.id);


                    const currentRound = activeRound?.number ?? 1;
                    const nextRound = currentRound + 1;

                    if (nextRound > 3) {
                        await supabase
                            .from("rooms")
                            .update({ state: "results", leaderboard_deadline: null })
                            .eq("id", room.id);

                        room.state = "results";
                    } else {
                        console.log(`[rooms] leaderboard ended -> starting round ${nextRound} room ${code}`);
                        await startRound(room, nextRound);

                        // Invalidate ALL cache so getActiveRound returns the new round immediately.
                        // Without this, the 10s cached activeRound still points to the old round,
                        // causing Unity to use the wrong round intro video.
                        cacheInvalidateRoom();

                        // startRound sets state=round_intro
                        room.state = "round_intro";
                    }
                }
            }
        }




        let voterIdsA = [];
        let voterIdsB = [];

        if (activeRound) {
            currentRound = Math.max((activeRound.number ?? 1) - 1, 0);

            // -----------------------------
            // PARALLEL ANSWERING GATE (Quiplash)
            // Stay in answering_all until EVERY player finished their assigned prompt
            // OR the answer deadline passes (auto-fill "Didn't answer")
            // -----------------------------
            if (room.started && room.state === "answering_all") {
                // Fetch prompts + answers in parallel
                const [_rpsRes, _ansRes] = await Promise.all([
                    supabase.from("round_prompts")
                        .select("id, player1_id, player2_id, answer_deadline, order_index")
                        .eq("round_id", activeRound.id),
                    supabase.from("answers")
                        .select("round_prompt_id, player_id")
                        .eq("round_id", activeRound.id),
                ]);

                if (_rpsRes.error) throw _rpsRes.error;
                if (_ansRes.error) throw _ansRes.error;
                const allRps = _rpsRes.data;
                const allAns = _ansRes.data;

                const answeredByRp = new Map();
                for (const a of allAns || []) {
                    if (!answeredByRp.has(a.round_prompt_id)) answeredByRp.set(a.round_prompt_id, new Set());
                    answeredByRp.get(a.round_prompt_id).add(a.player_id);
                }

                // Determine if deadline passed (use earliest/any rp deadline; they�re the same in your setup)
                let deadlinePassed = false;
                const anyDeadline = (allRps || []).find(x => x.answer_deadline)?.answer_deadline;
                if (anyDeadline) {
                    deadlinePassed = Date.now() > new Date(anyDeadline).getTime();
                }

                // If deadline passed, auto-insert "Didn't answer" for missing players
                if (deadlinePassed) {
                    for (const rpRow of (allRps || [])) {
                        const s = answeredByRp.get(rpRow.id) || new Set();

                        const missing = [];
                        if (!s.has(rpRow.player1_id)) missing.push(rpRow.player1_id);
                        if (!s.has(rpRow.player2_id)) missing.push(rpRow.player2_id);

                        for (const pid of missing) {
                            // Insert placeholder only if still missing (race-safe)
                            const { data: exists, error: exErr } = await supabase
                                .from("answers")
                                .select("id")
                                .eq("round_prompt_id", rpRow.id)
                                .eq("player_id", pid)
                                .limit(1)
                                .maybeSingle();

                            if (exErr) throw exErr;

                            if (!exists) {
                                await supabase.from("answers").insert({
                                    round_id: activeRound.id,
                                    round_prompt_id: rpRow.id,
                                    player_id: pid,
                                    text: "Didn't answer",
                                    created_at: nowIso(),
                                });
                                console.log(`[rooms] auto-filled missing answer for player ${pid} rp ${rpRow.id} room ${code}`);
                            }
                        }
                    }
                }

                // Recompute completion after optional autofill
                const { data: allAns2, error: allAns2Err } = await supabase
                    .from("answers")
                    .select("round_prompt_id, player_id")
                    .eq("round_id", activeRound.id);

                if (allAns2Err) throw allAns2Err;

                const answeredByRp2 = new Map();
                for (const a of allAns2 || []) {
                    if (!answeredByRp2.has(a.round_prompt_id)) answeredByRp2.set(a.round_prompt_id, new Set());
                    answeredByRp2.get(a.round_prompt_id).add(a.player_id);
                }

                const everyoneAnsweredNow = (allRps || []).every(r => {
                    const s = answeredByRp2.get(r.id) || new Set();
                    return s.has(r.player1_id) && s.has(r.player2_id);
                });

                if (everyoneAnsweredNow) {
                    console.log(`[rooms] all players answered (or auto-filled) in room ${code} -> switching to reveal`);

                    const revealSeconds = 10;
                    const revealDeadline = new Date(Date.now() + revealSeconds * 1000).toISOString();

                    const { error: roomErr } = await supabase
                        .from("rooms")
                        .update({
                            state: "reveal",
                            active_prompt_index: 0,
                            reveal_deadline: revealDeadline
                        })
                        .eq("id", room.id);

                    if (roomErr) throw roomErr;
                }
            }



            const rp = await getActiveRoundPrompt(activeRound.id, true);
            if (rp) {

                



                
                // -----------------------------
                // AUTO TRANSITION: reveal -> voting
                // -----------------------------
                if (room.started && room.state === "reveal" && room.reveal_deadline) {
                    const revealDeadlineMs = new Date(room.reveal_deadline).getTime();

                    if (Date.now() > revealDeadlineMs) {
                        const idx = Number.isInteger(room.active_prompt_index) ? room.active_prompt_index : 0;

                        const { data: rpToVote, error: rpErr } = await supabase
                            .from("round_prompts")
                            .select("id")
                            .eq("round_id", activeRound.id)
                            .eq("order_index", idx)
                            .maybeSingle();

                        if (rpErr) throw rpErr;

                        if (rpToVote) {
                            const voteSeconds = 25;
                            const voteDeadline = new Date(Date.now() + voteSeconds * 1000).toISOString();

                            await supabase
                                .from("round_prompts")
                                .update({ state: "voting", vote_deadline: voteDeadline })
                                .eq("id", rpToVote.id);

                            await supabase
                                .from("rooms")
                                .update({ state: "voting", reveal_deadline: null })
                                .eq("id", room.id);

                            // Refresh local state so this response is accurate
                            room.state = "voting";
                            room.reveal_deadline = null;
                            cacheInvalidateRoom();

                            console.log(`[rooms] reveal ended -> voting (idx=${idx}) room ${code}`);
                        }
                    }
                }





                // -----------------------------
                // AUTO PHASE TRANSITION LOGIC
                // voting -> done -> next prompt (or leaderboard)
                // Ends early if all eligible voters voted
                // -----------------------------
                if (room.started && rp.state === "voting") {
                    // ---------------------------------
                    // AUTO WIN if only one REAL answer exists
                    // (ignore "Didn't answer" placeholders)
                    // ---------------------------------
                    const { data: answerRows, error: ansCountErr } = await supabase
                        .from("answers")
                        .select("id, player_id, text")
                        .eq("round_prompt_id", rp.id);

                    if (ansCountErr) throw ansCountErr;

                    const realAnswers = (answerRows || []).filter(a => (a.text || "").trim() !== "Didn't answer");

                    // --- auto-award if <=1 real answer ---
                    const eligibleVoters = playersBasic
                        .map(p => p.id)
                        .filter(id => id !== rp.player1_id && id !== rp.player2_id);

                    let alreadyTransitioned = false;

                    if (realAnswers.length <= 1) {
                        console.log(`[rooms] <=1 real answer for rp ${rp.id}, auto awarding -> post_vote_pause`);

                        // If there is exactly 1 real answer, award it all eligible votes
                        if (realAnswers.length === 1 && eligibleVoters.length > 0) {
                            const winnerAnswerId = realAnswers[0].id;

                            const voteInserts = eligibleVoters.map(voterId => ({
                                answer_id: winnerAnswerId,
                                round_id: activeRound.id,
                                round_prompt_id: rp.id,
                                voter_player_id: voterId,
                                created_at: nowIso(),
                            }));

                            const { error: insVotesErr } = await supabase
                                .from("votes")
                                .upsert(voteInserts, { onConflict: "round_prompt_id,voter_player_id" });

                            if (insVotesErr) throw insVotesErr;
                        }

                        const { data: doneRows, error: doneErr } = await supabase
                            .from("round_prompts")
                            .update({ state: "done" })
                            .eq("id", rp.id)
                            .eq("state", "voting")
                            .select("id");

                        if (doneErr) throw doneErr;

                        if (doneRows && doneRows.length > 0) {
                            const pauseSeconds = 7;
                            const pauseDeadline = new Date(Date.now() + pauseSeconds * 1000).toISOString();

                            await supabase
                                .from("rooms")
                                .update({
                                    state: "post_vote_pause",
                                    reveal_deadline: pauseDeadline, // reuse as pause timer
                                })
                                .eq("id", room.id)
                                .eq("state", "voting");

                            // Refresh local state so this response is accurate
                            room.state = "post_vote_pause";
                            room.reveal_deadline = pauseDeadline;
                            cacheInvalidateRoom();
                            alreadyTransitioned = true;
                        }

                    }

                    // Only run normal voting check if auto-award didn't already transition
                    if (!alreadyTransitioned) {

                    // Count distinct voters for this round_prompt
                    const { data: voterRows, error: vCntErr } = await supabase
                        .from("votes")
                        .select("voter_player_id")
                        .eq("round_prompt_id", rp.id);

                    if (vCntErr) throw vCntErr;

                    const votedSet = new Set((voterRows || []).map(v => v.voter_player_id));
                    const allEligibleVoted =
                        eligibleVoters.length > 0 && eligibleVoters.every(id => votedSet.has(id));

                    // Deadline fallback
                    let deadlinePassed = false;
                    if (rp.vote_deadline) {
                        const voteDeadlineMs = new Date(rp.vote_deadline).getTime();
                        deadlinePassed = Date.now() > voteDeadlineMs;
                    }

                    if (allEligibleVoted || deadlinePassed) {
                        console.log(`[rooms] voting ended (early=${allEligibleVoted}) marking done for rp ${rp.id} room ${code}`);

                        const { data: doneRows, error: doneErr } = await supabase
                            .from("round_prompts")
                            .update({ state: "done" })
                            .eq("id", rp.id)
                            .eq("state", "voting")   // IMPORTANT: only transition once
                            .select("id");

                        if (doneErr) throw doneErr;

                        // If empty, someone already transitioned it
                        if (!doneRows || doneRows.length === 0) {
                            // do nothing
                        } else {
                            const pauseSeconds = 10;
                            const pauseDeadline = new Date(Date.now() + pauseSeconds * 1000).toISOString();

                            // Move to pause instead of instantly advancing
                            await supabase
                                .from("rooms")
                                .update({
                                    state: "post_vote_pause",
                                    reveal_deadline: pauseDeadline // reuse reveal_deadline as pause timer
                                })
                                .eq("id", room.id)
                                .eq("state", "voting");

                            // Refresh local state so this response is accurate
                            room.state = "post_vote_pause";
                            room.reveal_deadline = pauseDeadline;
                            cacheInvalidateRoom();
                        }
                    }

                    } // end !alreadyTransitioned

                } // end if (rp.state === "voting")



                // -----------------------------
                // PHASE + TIMER FOR UNITY
                // -----------------------------
                if (room.started) {
                    phase = room.state || phase;
                }




                let deadline = null;

                // Phase-specific deadlines first (room-level)
                if (room.state === "round_intro" && room.intro_deadline) {
                    deadline = room.intro_deadline;
                } else if (room.state === "leaderboard" && room.leaderboard_deadline) {
                    deadline = room.leaderboard_deadline;
                } else if (room.state === "reveal" && room.reveal_deadline) {
                    deadline = room.reveal_deadline;
                } else if (room.state === "post_vote_pause" && room.reveal_deadline) {
                    // post_vote_pause reuses reveal_deadline as the pause timer
                    deadline = room.reveal_deadline;
                } else if (rp) {
                    // fallback to prompt deadlines for answering/voting
                    if (room.state === "answering_all" || rp.state === "answering") deadline = rp.answer_deadline;
                    else if (room.state === "voting") deadline = rp.vote_deadline;
                }

                phaseEndTimestamp = deadline ? toUnixSeconds(deadline) : 0;


                // Parallelize answer status + vote counting queries
                const [_roundAnsRes, _activeAnsRes, _voteRes] = await Promise.all([
                    supabase.from("answers").select("player_id").eq("round_id", activeRound.id),
                    supabase.from("answers").select("id, player_id").eq("round_prompt_id", rp.id),
                    supabase.from("votes").select("answer_id, voter_player_id").eq("round_prompt_id", rp.id),
                ]);

                if (_roundAnsRes.error) throw _roundAnsRes.error;
                if (_activeAnsRes.error) throw _activeAnsRes.error;
                if (_voteRes.error) throw _voteRes.error;

                const roundAnswers = _roundAnsRes.data;
                const answeredSet = new Set((roundAnswers || []).map(a => a.player_id));

                const activeRpAnswers = _activeAnsRes.data;

                const voteRows = _voteRes.data;

                const voteCount = new Map();
                for (const v of voteRows || []) {
                    voteCount.set(v.answer_id, (voteCount.get(v.answer_id) || 0) + 1);
                }

                // Map player_id -> votes for the ACTIVE rp only
                const playerVotes = new Map();
                for (const a of (activeRpAnswers || [])) {
                    const c = voteCount.get(a.id) || 0;
                    playerVotes.set(a.player_id, (playerVotes.get(a.player_id) || 0) + c);
                }

                // Build voter ID lists so Unity can show the correct icon per voter index
                const answerIdToPlayerId = new Map((activeRpAnswers || []).map(a => [a.id, a.player_id]));
                for (const v of (voteRows || [])) {
                    const voteReceiverId = answerIdToPlayerId.get(v.answer_id);
                    if (voteReceiverId === rp.player1_id) voterIdsA.push(v.voter_player_id);
                    else if (voteReceiverId === rp.player2_id) voterIdsB.push(v.voter_player_id);
                }

                players = playersBasic.map(p => ({
                    id: p.id,
                    name: p.name,
                    answer: answeredSet.has(p.id) ? "x" : "",
                    votes: playerVotes.get(p.id) || 0,
                }));
            }

            // -----------------------------
            // FALLBACK: post_vote_pause vote counts
            // During post_vote_pause, getActiveRoundPrompt() may return:
            //   (a) null — both prompts are "done" (2nd prompt case)
            //   (b) the NEXT prompt (state="answering") — 1st prompt case
            // In both cases we need to look up the last-done prompt to get correct votes.
            // Without this, the 1st prompt's scoring always shows 0 because rp points
            // to prompt 1 (which has no votes yet).
            // -----------------------------
            const needsDoneFallback = room.state === "post_vote_pause" &&
                (!rp || (rp && rp.state !== "voting"));
            if (needsDoneFallback) {
                const { data: doneRp, error: doneRpErr } = await supabase
                    .from("round_prompts")
                    .select("id, player1_id, player2_id, order_index")
                    .eq("round_id", activeRound.id)
                    .eq("state", "done")
                    .order("order_index", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (!doneRpErr && doneRp) {
                    // Parallelize answers + votes fetch for this done prompt
                    const [_doneAnsRes, _doneVoteRes] = await Promise.all([
                        supabase.from("answers").select("id, player_id").eq("round_prompt_id", doneRp.id),
                        supabase.from("votes").select("answer_id, voter_player_id").eq("round_prompt_id", doneRp.id),
                    ]);

                    const doneRpAnswers = _doneAnsRes.data || [];
                    const doneVoteRows = _doneVoteRes.data || [];

                    const doneVoteCount = new Map();
                    for (const v of doneVoteRows) {
                        doneVoteCount.set(v.answer_id, (doneVoteCount.get(v.answer_id) || 0) + 1);
                    }

                    const donePlayerVotes = new Map();
                    for (const a of doneRpAnswers) {
                        const c = doneVoteCount.get(a.id) || 0;
                        donePlayerVotes.set(a.player_id, (donePlayerVotes.get(a.player_id) || 0) + c);
                    }

                    // Build voter ID lists for Unity vote icons (same logic as active rp block)
                    const doneAnswerIdToPlayerId = new Map(doneRpAnswers.map(a => [a.id, a.player_id]));
                    for (const v of doneVoteRows) {
                        const voteReceiverId = doneAnswerIdToPlayerId.get(v.answer_id);
                        if (voteReceiverId === doneRp.player1_id) voterIdsA.push(v.voter_player_id);
                        else if (voteReceiverId === doneRp.player2_id) voterIdsB.push(v.voter_player_id);
                    }

                    // Use reveal_deadline as post_vote_pause timer
                    if (room.reveal_deadline) {
                        phaseEndTimestamp = toUnixSeconds(room.reveal_deadline);
                    }

                    players = playersBasic.map(p => ({
                        id: p.id,
                        name: p.name,
                        answer: "x", // all answered (we're past answering phase)
                        votes: donePlayerVotes.get(p.id) || 0,
                    }));
                }
            }

        }

        // Room-level timers override per-rp timers
        if (room.state === "reveal" && room.reveal_deadline) {
            phaseEndTimestamp = toUnixSeconds(room.reveal_deadline);
        }


        res.json({
            success: true,
            phase,
            players,
            started,
            currentRound,
            phaseEndTimestamp,
            voterIdsA,
            voterIdsB,
        });
    } catch (e) {
        console.error("GET /rooms/:code error:", e);
        res.status(500).json({ success: false });
    }
});

/**
 * POST /rooms/:code/start
  * Body: { playerId }
 * Creates Round 1 + one round_prompt instance (for now) + sets deadlines.
 */
app.post("/rooms/:code/start", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const playerId = (req.body?.playerId || "").toString();
        if (!playerId) return res.status(400).json({ success: false, error: "missing_playerId" });
        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });
        if (!room.host_player_id || room.host_player_id !== playerId) {
            return res.status(403).json({ success: false, error: "not_host" });
        }


        // Get players (need 4 to match Unity start button logic)
        const players = await getPlayers(room.id);
        if (players.length < 4) {
            return res.status(400).json({ success: false, error: "not_enough_players" });
        }

        // Start Round 1 using the shared round starter (creates rps + intro phase)
        await startRound(room, 1);


        console.log(`[rooms] started room ${code}`);
        cacheInvalidateRoom();
        res.json({ success: true });
    } catch (e) {
        console.error("POST /rooms/:code/start error:", e);
        res.status(500).json({ success: false });
    }
});

/**
 * POST /rooms/:code/intro_done
 * Unity TV tells backend: intro video finished -> move to answering_all
 * No playerId required (Unity is the authoritative �TV�)
 */
app.post("/rooms/:code/intro_done", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false, error: "no_room" });

        if (room.state !== "round_intro") {
            return res.status(400).json({ success: false, error: "not_in_round_intro" });
        }

        // Get the active round so we can reset its answer deadlines
        const activeRound = await getActiveRound(room.id);
        if (!activeRound) return res.status(400).json({ success: false, error: "no_active_round" });

        // Reset answer_deadline on all round_prompts for this round to NOW + 90s
        // This ensures the 90s answering window starts when the intro video actually ends,
        // not when startRound() was called.
        const answerSeconds = 90;
        const newAnswerDeadline = new Date(Date.now() + answerSeconds * 1000).toISOString();

        const { error: rpErr } = await supabase
            .from("round_prompts")
            .update({ answer_deadline: newAnswerDeadline })
            .eq("round_id", activeRound.id)
            .eq("state", "answering");

        if (rpErr) throw rpErr;

        // Move room to answering_all
        const { error: uErr } = await supabase
            .from("rooms")
            .update({ state: "answering_all", intro_deadline: null })
            .eq("id", room.id)
            .eq("state", "round_intro"); // guard: only once

        if (uErr) throw uErr;

        console.log(`[rooms] intro_done -> answering_all room ${code}, answer_deadline reset to +${answerSeconds}s`);
        cacheInvalidateRoom();
        res.json({ success: true });
    } catch (e) {
        console.error("POST /rooms/:code/intro_done error:", e);
        res.status(500).json({ success: false });
    }
});








/**
 * GET /rooms/:code/question?playerId=UUID
 * Returns the prompt assigned to THIS player (during answering).
 */
app.get("/rooms/:code/question", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const playerId = (req.query.playerId || "").toString();

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.json({ success: true, question: "", roundNumber: 0, roundPromptId: null });

        // If playerId provided: return THAT player's assigned prompt (parallel answering)
        if (playerId) {
            const { data: rp, error: rpErr } = await supabase
                .from("round_prompts")
                .select("id, prompt_id")
                .eq("round_id", round.id)
                .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`)
                .limit(1)
                .maybeSingle();

            if (rpErr) throw rpErr;

            if (!rp) {
                return res.json({ success: true, question: "", roundNumber: round.number, roundPromptId: null });
            }

            const text = await getPromptText(rp.prompt_id);
            return res.json({ success: true, question: text, roundNumber: round.number, roundPromptId: rp.id });
        }

        // No playerId: Unity/TV fallback uses the CURRENT reveal index (or 0)
        const idx = Number.isInteger(room.active_prompt_index) ? room.active_prompt_index : 0;

        const { data: rp2, error: rp2Err } = await supabase
            .from("round_prompts")
            .select("id, prompt_id")
            .eq("round_id", round.id)
            .eq("order_index", idx)
            .limit(1)
            .maybeSingle();

        if (rp2Err) throw rp2Err;

        if (!rp2) {
            return res.json({ success: true, question: "", roundNumber: round.number, roundPromptId: null });
        }

        const text2 = await getPromptText(rp2.prompt_id);
        return res.json({ success: true, question: text2, roundNumber: round.number, roundPromptId: rp2.id });
    } catch (e) {
        console.error("GET /rooms/:code/question error:", e);
        res.status(500).json({ success: false });
    }
});



app.post("/rooms/:code/join", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const name = (req.body?.name || "Player").toString().slice(0, 24);

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });

        const players = await getPlayers(room.id);
        if (players.length >= (room.max_players || 4)) {
            return res.status(400).json({ success: false, error: "room_full" });
        }



        // seat = next number
        const seat = players.length + 1;

        // Prevent duplicate join with same display name in same room
        const { data: existing } = await supabase
            .from("room_players")
            .select("id")
            .eq("room_id", room.id)
            .eq("display_name", name)
            .limit(1)
            .maybeSingle();

        if (existing) {
            const isHost = !!room.host_player_id && room.host_player_id === existing.id;
            return res.json({ success: true, playerId: existing.id, isHost });
        }



        const { data, error } = await supabase
            .from("room_players")
            .insert({
                room_id: room.id,
                display_name: name,
                joined_at: nowIso(),
                seat,
            })
            .select("id")
            .single();

        if (error) throw error;

        // If no host yet, first joiner becomes host
        let isHost = false;
        if (!room.host_player_id) {
            const { error: hErr } = await supabase
                .from("rooms")
                .update({ host_player_id: data.id })
                .eq("id", room.id);

            if (hErr) throw hErr;
            isHost = true;
        }


        console.log(`[rooms] player joined ${code}: ${name}`);
        cacheInvalidate('players:');
        res.json({ success: true, playerId: data.id, isHost });
    } catch (e) {
        console.error("POST /rooms/:code/join error:", e);
        res.status(500).json({ success: false });
    }
});

app.post("/rooms/:code/answer", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const playerId = (req.body?.playerId || "").toString();

        if (!playerId) {
            return res.status(400).json({ success: false, error: "missing_playerId" });
        }

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false, error: "no_room" });

        const round = await getActiveRound(room.id);
        if (!round) return res.status(400).json({ success: false, error: "no_round" });

        // Find the round_prompt assigned to THIS player (parallel answering)
        const { data: rp, error: rpErr } = await supabase
            .from("round_prompts")
            .select("id, state, answer_deadline, vote_deadline, order_index, prompt_id, player1_id, player2_id")
            .eq("round_id", round.id)
            .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`)
            .limit(1)
            .maybeSingle();

        if (rpErr) throw rpErr;
        if (!rp) return res.status(400).json({ success: false, error: "no_prompt_for_player" });

        // Only accept answers during answering phase
        if (rp.state !== "answering") {
            return res.status(400).json({ success: false, error: "not_in_answering" });
        }

        // Only the two assigned players can answer THIS prompt
        if (playerId !== rp.player1_id && playerId !== rp.player2_id) {
            return res.status(400).json({ success: false, error: "not_assigned_to_prompt" });
        }

        // Enforce deadline
        if (rp.answer_deadline && Date.now() > new Date(rp.answer_deadline).getTime()) {
            return res.status(400).json({ success: false, error: "answer_deadline_passed" });
        }

        // ----------------------------
        // Round 3: must submit exactly 3 answers in ONE request
        // Stored as ONE combined row so voting stays 1 option per player
        // ----------------------------
        if (round.number === 3) {
            const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
            const clean = texts.map(t => (t ?? "").toString().trim()).filter(t => t.length > 0);

            if (clean.length !== 3) {
                return res.status(400).json({ success: false, error: "need_3_answers" });
            }

            // If already answered (combined row exists), stop
            const { data: existing, error: exErr } = await supabase
                .from("answers")
                .select("id")
                .eq("round_prompt_id", rp.id)
                .eq("player_id", playerId);

            if (exErr) throw exErr;
            if ((existing || []).length > 0) {
                return res.json({ success: true, alreadyAnswered: true });
            }

            const combined = clean.join("\n"); // keep as one unified answer

            const { error: insErr } = await supabase.from("answers").insert({
                round_id: round.id,
                round_prompt_id: rp.id,
                player_id: playerId,
                text: combined,
                created_at: nowIso(),
            });

            if (insErr) throw insErr;

            console.log(`[rooms] answer accepted (round3 bundle) room ${code} player ${playerId}`);
            cacheInvalidateRoom();
            return res.json({ success: true });
        }

        // ----------------------------
        // Rounds 1-2: single answer
        // ----------------------------
        const text = (req.body?.text || "").toString().trim();
        if (!text) {
            return res.status(400).json({ success: false, error: "missing_text" });
        }

        // Only 1 answer allowed
        const { data: existingAnswers, error: exErr } = await supabase
            .from("answers")
            .select("id")
            .eq("round_prompt_id", rp.id)
            .eq("player_id", playerId);

        if (exErr) throw exErr;

        if ((existingAnswers || []).length >= 1) {
            return res.json({ success: true, alreadyAnswered: true });
        }

        const { error: insErr } = await supabase.from("answers").insert({
            round_id: round.id,
            round_prompt_id: rp.id,
            player_id: playerId,
            text,
            created_at: nowIso(),
        });

        if (insErr) throw insErr;

        console.log(`[rooms] answer accepted room ${code} player ${playerId}`);
        cacheInvalidateRoom();
        return res.json({ success: true });

    } catch (e) {
        console.error("POST /rooms/:code/answer error:", e);
        res.status(500).json({ success: false });
    }
});



app.post("/rooms/:code/vote", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const { voterPlayerId, answerId } = req.body || {};

        if (!voterPlayerId || !answerId) {
            return res.status(400).json({ success: false, error: "missing_fields" });
        }

        // Skip cache for freshness — vote is time-critical
        const room = await getRoomByCode(code, true);
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.status(400).json({ success: false, error: "no_round" });

        // Try active prompt first; fall back to recently-done prompt (race-safe)
        let rp = await getActiveRoundPrompt(round.id, true);
        if (!rp) {
            // Prompt may have just transitioned to "done" while player was voting
            const { data: lastRp } = await supabase
                .from("round_prompts")
                .select("id, state, answer_deadline, vote_deadline, order_index, prompt_id, player1_id, player2_id")
                .eq("round_id", round.id)
                .eq("state", "done")
                .order("order_index", { ascending: false })
                .limit(1)
                .maybeSingle();
            rp = lastRp;
        }
        if (!rp) return res.status(400).json({ success: false, error: "no_prompt" });

        // Accept votes during "voting" OR recently "done" (race window)
        if (rp.state !== "voting" && rp.state !== "done") {
            return res.status(400).json({ success: false, error: "not_in_voting" });
        }

        // Disallow voting by the two answerers
        if (voterPlayerId === rp.player1_id || voterPlayerId === rp.player2_id) {
            return res.status(400).json({ success: false, error: "answerers_cannot_vote" });
        }

        // Insert vote directly — unique constraint prevents double vote
        // Skip separate answer validation for speed (answerId comes from /voting response)
        const { error: vErr } = await supabase.from("votes").insert({
            answer_id: answerId,
            round_id: round.id,
            round_prompt_id: rp.id,
            voter_player_id: voterPlayerId,
            created_at: nowIso(),
        });

        if (vErr) {
            // Duplicate vote attempt
            if (vErr.code === "23505") {
                return res.json({ success: true, alreadyVoted: true });
            }
            throw vErr;
        }

        // Invalidate cache so polling picks up new vote count immediately
        cacheInvalidateRoom();

        console.log(`[rooms] vote accepted room ${code} voter ${voterPlayerId} -> ${answerId}`);
        res.json({ success: true });
    } catch (e) {
        console.error("POST /rooms/:code/vote error:", e);
        res.status(500).json({ success: false });
    }
});

app.get("/rooms/:code/voting", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();

        const room = await getRoomByCode(code, true); // skip cache for freshness
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.status(400).json({ success: false, error: "no_round" });

        // Try active prompt first; fall back to last-done prompt (race-safe, same as /vote)
        let rp = await getActiveRoundPrompt(round.id, true);
        if (!rp) {
            const { data: lastRp } = await supabase
                .from("round_prompts")
                .select("id, state, answer_deadline, vote_deadline, order_index, prompt_id, player1_id, player2_id")
                .eq("round_id", round.id)
                .eq("state", "done")
                .order("order_index", { ascending: false })
                .limit(1)
                .maybeSingle();
            rp = lastRp;
        }
        if (!rp) return res.status(400).json({ success: false, error: "no_prompt" });

        const promptText = await getPromptText(rp.prompt_id);

        // Only meaningful during voting or recently done (race-safe)
        if (rp.state !== "voting" && rp.state !== "done") {
            return res.status(400).json({ success: false, error: "not_in_voting" });
        }

        // Get answers for this prompt, include id so clients can vote
        const { data: answers, error } = await supabase
            .from("answers")
            .select("id, player_id, text, created_at")
            .eq("round_prompt_id", rp.id)
            .order("created_at", { ascending: true });

        if (error) throw error;

        const realAnswers = (answers || []).filter(a => (a.text || "").trim() !== "Didn't answer");

        // ROUND 3: collapse 3 answers per player into ONE voting option
        let finalAnswers = realAnswers;

        if (round.number === 3) {
            const byPlayer = new Map();

            for (const a of realAnswers) {
                if (!byPlayer.has(a.player_id)) byPlayer.set(a.player_id, []);
                byPlayer.get(a.player_id).push(a);
            }

            const collapsed = [];
            for (const [playerId, arr] of byPlayer.entries()) {
                // already ordered by created_at, but keep it safe:
                arr.sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime());

                const canonical = arr[0]; // vote will attach to this answer_id
                const joinedText = arr.map(x => x.text).join(" | ");

                collapsed.push({
                    id: canonical.id,
                    player_id: playerId,
                    text: joinedText,
                });
            }

            finalAnswers = collapsed;
        }



        // Map player_id -> display name
        const players = await getPlayers(room.id);
        const nameByPlayerId = new Map(players.map(p => [p.id, p.name || "Player"]));

        const options = (finalAnswers || []).map(a => ({
            answerId: a.id,
            playerId: a.player_id,
            playerName: nameByPlayerId.get(a.player_id) || "Player",
            text: a.text,
        }));


        res.json({
            success: true,
            roomCode: code,
            roundPromptId: rp.id,
            promptText,
            options,
        });
    } catch (e) {
        console.error("GET /rooms/:code/voting error:", e);
        res.status(500).json({ success: false });
    }
});

app.get("/rooms/:code/reveal", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();
        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.json({ success: false });

        const idx = Number.isInteger(room.active_prompt_index) ? room.active_prompt_index : 0;

        const { data: rp, error: rpErr } = await supabase
            .from("round_prompts")
            .select("id, prompt_id, player1_id, player2_id")
            .eq("round_id", round.id)
            .eq("order_index", idx)
            .maybeSingle();

        if (rpErr) throw rpErr;
        if (!rp) return res.json({ success: false });

        const promptText = await getPromptText(rp.prompt_id);

        const { data: answers, error: ansErr } = await supabase
            .from("answers")
            .select("id, player_id, text")
            .eq("round_prompt_id", rp.id);

        if (ansErr) throw ansErr;

        // Sort answers so player1's answer comes first, player2's second.
        // Unity maps answers[0] -> A (left), answers[1] -> B (right).
        // Server maps voterIdsA -> player1, voterIdsB -> player2.
        // Without this sort, the mapping is random and icons/scores appear swapped.
        const sortedAnswers = (answers || []).sort((a, b) => {
            if (a.player_id === rp.player1_id) return -1;
            if (b.player_id === rp.player1_id) return 1;
            return 0;
        });

        res.json({
            success: true,
            prompt: promptText,
            roundPromptId: rp.id,
            answers: sortedAnswers
        });

    } catch (e) {
        console.error("GET /rooms/:code/reveal error:", e);
        res.status(500).json({ success: false });
    }
});


app.get("/rooms/:code/results", async (req, res) => {
    try {
        const code = (req.params.code || "").toUpperCase();

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.status(400).json({ success: false });

        const rp = await getActiveRoundPrompt(round.id);
        if (!rp || rp.state !== "done") {
            return res.status(400).json({ success: false, error: "not_in_results" });
        }

        const { data: answers, error: ansErr } = await supabase
            .from("answers")
            .select("id, player_id, text")
            .eq("round_prompt_id", rp.id);

        if (ansErr) throw ansErr;

        const { data: votes, error: vErr } = await supabase
            .from("votes")
            .select("answer_id")
            .eq("round_prompt_id", rp.id);

        if (vErr) throw vErr;

        const voteCount = new Map();
        for (const v of allVotes || []) {
            voteCount.set(v.answer_id, (voteCount.get(v.answer_id) || 0) + 1);
        }


        const players = await getPlayers(room.id);
        const nameById = new Map(players.map(p => [p.id, p.name]));

        const results = (answers || []).map(a => ({
            answerId: a.id,
            playerId: a.player_id,
            playerName: nameById.get(a.player_id) || "Player",
            text: a.text,
            votes: voteCount.get(a.id) || 0,
        })).sort((a, b) => b.votes - a.votes);

        res.json({
            success: true,
            roomCode: code,
            results,
            winner: results[0] || null,
        });
    } catch (e) {
        console.error("GET /rooms/:code/results error:", e);
        res.status(500).json({ success: false });
    }
});

async function handleRoundResults(req, res) {
    try {
        const code = (req.params.code || "").toUpperCase();

        const room = await getRoomByCode(code);
        if (!room) return res.status(404).json({ success: false });

        const round = await getActiveRound(room.id);
        if (!round) return res.status(400).json({ success: false, error: "no_round" });

        // Only serve round results when the room is actually in leaderboard
        if (room.state !== "leaderboard") {
            return res.status(400).json({ success: false, error: "not_in_leaderboard" });
        }

        // Get all round_prompts for this round, ordered
        const { data: rps, error: rpErr } = await supabase
            .from("round_prompts")
            .select("id, order_index, prompt_id, player1_id, player2_id")
            .eq("round_id", round.id)
            .order("order_index", { ascending: true });

        if (rpErr) throw rpErr;

        // We only support 2 matchups for now (idx 0,1) to match Unity round1/round2 fields
        const rp0 = (rps || []).find(x => x.order_index === 0);
        const rp1 = (rps || []).find(x => x.order_index === 1);

        // Prompt texts (questions array)
        const questions = [];
        if (rp0) questions.push(await getPromptText(rp0.prompt_id));
        if (rp1) questions.push(await getPromptText(rp1.prompt_id));

        // --- cumulative scoring across ALL rounds in this room ---
        const { data: allRounds, error: allRoundsErr } = await supabase
            .from("rounds")
            .select("id, number")
            .eq("room_id", room.id);

        if (allRoundsErr) throw allRoundsErr;

        const roundIds = (allRounds || []).map(r => r.id);
        const roundNumberById = new Map((allRounds || []).map(r => [r.id, r.number]));
        if (roundIds.length === 0) {
            return res.json({ success: true, questions: [], results: [] });
        }



        // All answers for ALL rounds in room
        const { data: allAnswers, error: ansErr } = await supabase
            .from("answers")
            .select("id, round_id, round_prompt_id, player_id, text")
            .in("round_id", roundIds);

        if (ansErr) throw ansErr;

        // All votes for ALL rounds in room
        const { data: allVotes, error: vErr } = await supabase
            .from("votes")
            .select("answer_id")
            .in("round_id", roundIds);

        if (vErr) throw vErr;


        // Count votes per answer_id
        const voteCount = new Map();
        for (const v of allVotes || []) {
            voteCount.set(v.answer_id, (voteCount.get(v.answer_id) || 0) + 1);
        }


        // Player names
        const players = await getPlayers(room.id);
        const nameById = new Map(players.map(p => [p.id, p.name || "Player"]));

        // Build per-player result rows for Unity
        const rowByPlayer = new Map();
        for (const p of players) {
            rowByPlayer.set(p.id, {
                id: p.id,
                name: nameById.get(p.id) || "Player",
                round1Answer: "",
                round2Answer: "",
                totalVotes: 0
            });
        }

        // Helper: add a player's answer into the correct slot
        function applyAnswer(rpObj, answerText, playerId) {
            if (!rpObj) return;
            if (rpObj.order_index === 0) rowByPlayer.get(playerId).round1Answer = answerText;
            if (rpObj.order_index === 1) rowByPlayer.get(playerId).round2Answer = answerText;
        }

        // Assign answers + accumulate votes
        for (const a of allAnswers || []) {
            const row = rowByPlayer.get(a.player_id);
            if (!row) continue;

            // Which prompt index is this answer for?
            if (rp0 && a.round_prompt_id === rp0.id) applyAnswer(rp0, a.text, a.player_id);
            if (rp1 && a.round_prompt_id === rp1.id) applyAnswer(rp1, a.text, a.player_id);

            const votes = voteCount.get(a.id) || 0;
            const roundNum = roundNumberById.get(a.round_id) || 1;

            let mult = 1;
            if (roundNum === 2) mult = 2;      // Round 2 = double
            if (roundNum === 3) mult = 3;      // Round 3 = triple

            row.totalVotes += votes * 100 * mult;


        }

        // Final results array sorted by totalVotes desc
        const results = Array.from(rowByPlayer.values())
            .sort((a, b) => b.totalVotes - a.totalVotes);

        res.json({
            success: true,
            questions,
            results
        });
    } catch (e) {
        console.error("GET roundresults error:", e);
        res.status(500).json({ success: false });
    }
}


// Unity expects this:
app.get("/rooms/:code/roundresults", handleRoundResults);

// Optional: keep a nicer name too:
app.get("/rooms/:code/results", handleRoundResults);





app.listen(PORT, () => {
    console.log(`Rooms API listening on http://localhost:${PORT}`);
});
