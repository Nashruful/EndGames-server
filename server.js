// server.js - Quiplash Game Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // In production, specify your Unity and web client URLs
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

// In-memory game state (for active timers and real-time state)
const activeGames = new Map();

// ==================== HELPER FUNCTIONS ====================

// Generate a unique room code
function generateRoomCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing characters
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

// Shuffle array (for randomizing prompts and pairings)
function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

// Get least-paired players for fair matchups
async function getOptimalPairing(gameId, playerIds, round) {
  const { data: history } = await supabase
    .from('pairings_history')
    .select('*')
    .eq('game_id', gameId);

  // Count how many times each pair has been matched
  const pairCounts = new Map();
  
  if (history) {
    history.forEach(pairing => {
      const key = [pairing.player1_id, pairing.player2_id].sort().join('-');
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    });
  }

  // Try to find pairs that haven't been matched yet
  const availablePlayers = [...playerIds];
  const pairs = [];

  while (availablePlayers.length >= 2) {
    let bestPair = null;
    let lowestCount = Infinity;

    // Find the pair with the least history
    for (let i = 0; i < availablePlayers.length; i++) {
      for (let j = i + 1; j < availablePlayers.length; j++) {
        const key = [availablePlayers[i], availablePlayers[j]].sort().join('-');
        const count = pairCounts.get(key) || 0;
        
        if (count < lowestCount) {
          lowestCount = count;
          bestPair = [i, j];
        }
      }
    }

    if (bestPair) {
      const [i, j] = bestPair;
      pairs.push([availablePlayers[i], availablePlayers[j]]);
      
      // Remove paired players (remove higher index first to avoid shifting)
      availablePlayers.splice(Math.max(i, j), 1);
      availablePlayers.splice(Math.min(i, j), 1);
    }
  }

  return pairs;
}

// ==================== API ROUTES ===================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Quiplash server is running' });
});

// Create a new game
app.post('/api/game/create', async (req, res) => {
  try {
    const roomCode = generateRoomCode();
    
    const { data, error } = await supabase
      .from('games')
      .insert([
        {
          room_code: roomCode,
          status: 'waiting',
          current_round: 0,
          current_prompt_index: 0
        }
      ])
      .select()
      .single();

    if (error) throw error;

    // Initialize game state in memory
    activeGames.set(data.id, {
      roomCode: roomCode,
      timers: {},
      connectedSockets: new Map()
    });

    res.json({ success: true, game: data, roomCode });
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Join a game
app.post('/api/game/join', async (req, res) => {
  try {
    const { roomCode, username } = req.body;

    if (!roomCode || !username) {
      return res.status(400).json({ success: false, error: 'Room code and username required' });
    }

    // Find the game
    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('*')
      .eq('room_code', roomCode.toUpperCase())
      .single();

    if (gameError || !game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    // Check if game has started
    if (game.status !== 'waiting') {
      return res.status(400).json({ success: false, error: 'Game already started' });
    }

    // Count current players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', game.id);

    if (playersError) throw playersError;

    if (players.length >= game.max_players) {
      return res.status(400).json({ success: false, error: 'Game is full' });
    }

    // Add player
    const { data: newPlayer, error: playerError } = await supabase
      .from('players')
      .insert([
        {
          game_id: game.id,
          username: username,
          score: 0,
          is_narrator: false,
          is_connected: true,
          player_status: 'active'
        }
      ])
      .select()
      .single();

    if (playerError) throw playerError;

    // Notify all clients in the game room
    io.to(game.id).emit('playerJoined', {
      player: newPlayer,
      totalPlayers: players.length + 1
    });

    res.json({ success: true, player: newPlayer, game });
  } catch (error) {
    console.error('Error joining game:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the game
app.post('/api/game/:gameId/start', async (req, res) => {
  try {
    const { gameId } = req.params;

    // Get players count
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .eq('player_status', 'active');

    if (playersError) throw playersError;

    if (players.length < 3) {
      return res.status(400).json({ success: false, error: 'Need at least 3 players' });
    }

    // Update game status
    const { data: game, error: gameError } = await supabase
      .from('games')
      .update({ 
        status: 'intro',
        started_at: new Date().toISOString()
      })
      .eq('id', gameId)
      .select()
      .single();

    if (gameError) throw gameError;

    // Notify all clients
    io.to(gameId).emit('gameStarted', { game });

    // After intro animation (simulate 5 seconds), move to round 1
    setTimeout(() => {
      startRound(gameId, 1);
    }, 5000);

    res.json({ success: true, game });
  } catch (error) {
    console.error('Error starting game:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== GAME LOGIC FUNCTIONS ====================

async function startRound(gameId, roundNumber) {
  try {
    // Update game status
    await supabase
      .from('games')
      .update({ 
        status: `round${roundNumber}`,
        current_round: roundNumber,
        current_prompt_index: 0
      })
      .eq('id', gameId);

    // Get active players
    const { data: players } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .eq('player_status', 'active');

    // Handle narrator for round 3 if odd number of players
    let actualPlayers = [...players];
    if (roundNumber === 3 && players.length % 2 !== 0) {
      // Add narrator
      const { data: narrator } = await supabase
        .from('players')
        .insert([{
          game_id: gameId,
          username: 'The Narrator',
          score: 0,
          is_narrator: true,
          is_connected: true,
          player_status: 'active'
        }])
        .select()
        .single();
      
      actualPlayers.push(narrator);
    }

    // Get prompts for this round
    const { data: availablePrompts } = await supabase
      .from('prompts')
      .select('*')
      .eq('round_type', roundNumber)
      .eq('is_active', true);

    if (!availablePrompts || availablePrompts.length === 0) {
      console.error('No prompts available for round', roundNumber);
      return;
    }

    // Shuffle and select prompts (need enough for all player pairs)
    const shuffledPrompts = shuffleArray(availablePrompts);
    const pairsNeeded = Math.floor(actualPlayers.length / 2);
    const selectedPrompts = shuffledPrompts.slice(0, pairsNeeded);

    // Create optimal pairings
    const playerIds = actualPlayers.map(p => p.id);
    const pairs = await getOptimalPairing(gameId, playerIds, roundNumber);

    // Create game_prompts entries
    for (let i = 0; i < pairs.length && i < selectedPrompts.length; i++) {
      const [player1Id, player2Id] = pairs[i];
      const prompt = selectedPrompts[i];

      // Calculate eligible voters (all players except the two answering)
      const eligibleVoters = actualPlayers.length - 2;

      const { data: gamePrompt } = await supabase
        .from('game_prompts')
        .insert([{
          game_id: gameId,
          prompt_id: prompt.id,
          round: roundNumber,
          order_index: i,
          player1_id: player1Id,
          player2_id: player2Id,
          eligible_voters_count: eligibleVoters,
          answer_deadline: new Date(Date.now() + 90000).toISOString() // 90 seconds from now
        }])
        .select()
        .single();

      // Record pairing in history
      await supabase
        .from('pairings_history')
        .insert([{
          game_id: gameId,
          player1_id: player1Id,
          player2_id: player2Id,
          round: roundNumber
        }]);
    }

    // Notify clients to show round intro
    io.to(gameId).emit('roundIntro', { round: roundNumber });

    // After intro (simulate 3 seconds), start answering phase
    setTimeout(() => {
      startAnsweringPhase(gameId, roundNumber);
    }, 3000);

  } catch (error) {
    console.error('Error starting round:', error);
  }
}

async function startAnsweringPhase(gameId, roundNumber) {
  try {
    // Get all prompts for this round
    const { data: gamePrompts } = await supabase
      .from('game_prompts')
      .select(`
        *,
        prompt:prompts(*),
        player1:player1_id(*),
        player2:player2_id(*)
      `)
      .eq('game_id', gameId)
      .eq('round', roundNumber);

    // Notify clients with their prompts
    gamePrompts.forEach(gp => {
      // Send to player 1
      io.to(gp.player1_id).emit('yourPrompt', {
        gamePromptId: gp.id,
        promptText: gp.prompt.text,
        roundType: roundNumber,
        deadline: gp.answer_deadline
      });

      // Send to player 2
      io.to(gp.player2_id).emit('yourPrompt', {
        gamePromptId: gp.id,
        promptText: gp.prompt.text,
        roundType: roundNumber,
        deadline: gp.answer_deadline
      });
    });

    // Notify Unity display
    io.to(gameId).emit('answeringPhase', {
      round: roundNumber,
      duration: 90
    });

    // After 90 seconds, start voting phase
    setTimeout(() => {
      startVotingPhase(gameId, roundNumber);
    }, 90000);

  } catch (error) {
    console.error('Error starting answering phase:', error);
  }
}

async function startVotingPhase(gameId, roundNumber) {
  try {
    await supabase
      .from('games')
      .update({ 
        status: 'voting',
        current_prompt_index: 0
      })
      .eq('id', gameId);

    // Get all game prompts with answers
    const { data: gamePrompts } = await supabase
      .from('game_prompts')
      .select(`
        *,
        prompt:prompts(*),
        answers(*)
      `)
      .eq('game_id', gameId)
      .eq('round', roundNumber)
      .order('order_index');

    if (!gamePrompts || gamePrompts.length === 0) {
      // No prompts, end round
      endRound(gameId, roundNumber);
      return;
    }

    // Start voting on first prompt
    showPromptForVoting(gameId, gamePrompts[0], 0, gamePrompts.length);

  } catch (error) {
    console.error('Error starting voting phase:', error);
  }
}

async function showPromptForVoting(gameId, gamePrompt, index, total) {
  try {
    // Set voting deadline
    const votingDeadline = new Date(Date.now() + 30000).toISOString(); // 30 seconds to vote
    
    await supabase
      .from('game_prompts')
      .update({ voting_deadline: votingDeadline })
      .eq('id', gamePrompt.id);

    // Get full details with answers
    const { data: fullPrompt } = await supabase
      .from('game_prompts')
      .select(`
        *,
        prompt:prompts(*),
        answers(*),
        player1:player1_id(*),
        player2:player2_id(*)
      `)
      .eq('id', gamePrompt.id)
      .single();

    // Notify all clients
    io.to(gameId).emit('showPromptVoting', {
      gamePrompt: fullPrompt,
      index: index,
      total: total,
      deadline: votingDeadline
    });

    // After voting time, show results
    setTimeout(() => {
      showVotingResults(gameId, gamePrompt.id, index, total);
    }, 30000);

  } catch (error) {
    console.error('Error showing prompt for voting:', error);
  }
}

async function showVotingResults(gameId, gamePromptId, index, total) {
  try {
    // Get answers with vote counts
    const { data: answers } = await supabase
      .from('answers')
      .select('*, player:player_id(*)')
      .eq('game_prompt_id', gamePromptId);

    // Get the game prompt to know eligible voters
    const { data: gamePrompt } = await supabase
      .from('game_prompts')
      .select('eligible_voters_count')
      .eq('id', gamePromptId)
      .single();

    // Calculate scores and check for 100% votes
    const scoreMultiplier = await getScoreMultiplier(gamePromptId);
    
    for (const answer of answers) {
      const baseScore = answer.votes_received * 100;
      let bonusScore = 0;
      let got100Percent = false;

      // Check if got all votes
      if (answer.votes_received === gamePrompt.eligible_voters_count && gamePrompt.eligible_voters_count > 0) {
        bonusScore = 500;
        got100Percent = true;

        // Update answer
        await supabase
          .from('answers')
          .update({ got_100_percent: true })
          .eq('id', answer.id);
      }

      // Calculate total score for this prompt
      const totalScore = (baseScore + bonusScore) * scoreMultiplier;

      // Update player score
      await supabase.rpc('increment_player_score', {
        player_id: answer.player_id,
        score_to_add: totalScore
      });

      // If this function doesn't exist, use this alternative:
      const { data: player } = await supabase
        .from('players')
        .select('score')
        .eq('id', answer.player_id)
        .single();
      
      await supabase
        .from('players')
        .update({ score: player.score + totalScore })
        .eq('id', answer.player_id);
    }

    // Get updated players for display
    const { data: updatedPlayers } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .order('score', { ascending: false });

    // Show results
    io.to(gameId).emit('votingResults', {
      answers,
      players: updatedPlayers
    });

    // After showing results (5 seconds), move to next prompt or end round
    setTimeout(() => {
      if (index + 1 < total) {
        // More prompts to vote on
        moveToNextPrompt(gameId, index + 1, total);
      } else {
        // Round is over
        const { data: game } = supabase
          .from('games')
          .select('current_round')
          .eq('id', gameId)
          .single()
          .then(({ data }) => {
            endRound(gameId, data.current_round);
          });
      }
    }, 5000);

  } catch (error) {
    console.error('Error showing voting results:', error);
  }
}

async function moveToNextPrompt(gameId, nextIndex, total) {
  try {
    // Update current prompt index
    await supabase
      .from('games')
      .update({ current_prompt_index: nextIndex })
      .eq('id', gameId);

    // Get the game round
    const { data: game } = await supabase
      .from('games')
      .select('current_round')
      .eq('id', gameId)
      .single();

    // Get next prompt
    const { data: nextPrompt } = await supabase
      .from('game_prompts')
      .select(`
        *,
        prompt:prompts(*),
        answers(*)
      `)
      .eq('game_id', gameId)
      .eq('round', game.current_round)
      .eq('order_index', nextIndex)
      .single();

    showPromptForVoting(gameId, nextPrompt, nextIndex, total);

  } catch (error) {
    console.error('Error moving to next prompt:', error);
  }
}

async function getScoreMultiplier(gamePromptId) {
  const { data: gamePrompt } = await supabase
    .from('game_prompts')
    .select('round')
    .eq('id', gamePromptId)
    .single();

  // Round 1: 1x, Round 2: 2x, Round 3: 1x (but triple answers)
  return gamePrompt.round === 2 ? 2 : 1;
}

async function endRound(gameId, roundNumber) {
  try {
    await supabase
      .from('games')
      .update({ status: 'scoreboard' })
      .eq('id', gameId);

    // Get final scores
    const { data: players } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .eq('is_narrator', false)
      .order('score', { ascending: false });

    // Show scoreboard
    io.to(gameId).emit('showScoreboard', {
      round: roundNumber,
      players
    });

    // After scoreboard (5 seconds), move to next round or end game
    setTimeout(() => {
      if (roundNumber < 3) {
        startRound(gameId, roundNumber + 1);
      } else {
        endGame(gameId);
      }
    }, 5000);

  } catch (error) {
    console.error('Error ending round:', error);
  }
}

async function endGame(gameId) {
  try {
    await supabase
      .from('games')
      .update({ status: 'ended' })
      .eq('id', gameId);

    // Get winner
    const { data: players } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .eq('is_narrator', false)
      .order('score', { ascending: false });

    // Get all 100% vote answers for credits
    const { data: perfectAnswers } = await supabase
      .from('answers')
      .select(`
        *,
        player:player_id(*),
        game_prompt:game_prompts(prompt:prompts(*))
      `)
      .eq('got_100_percent', true)
      .in('game_prompt_id', 
        (await supabase
          .from('game_prompts')
          .select('id')
          .eq('game_id', gameId)
        ).data.map(gp => gp.id)
      );

    // Show winner and credits
    io.to(gameId).emit('gameEnded', {
      winner: players[0],
      finalScores: players,
      perfectAnswers
    });

    // Clean up active game from memory
    activeGames.delete(gameId);

  } catch (error) {
    console.error('Error ending game:', error);
  }
}

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Player joins a game room
  socket.on('joinGameRoom', async ({ gameId, playerId }) => {
    socket.join(gameId);
    socket.join(playerId); // Also join player's personal room
    
    if (activeGames.has(gameId)) {
      const gameState = activeGames.get(gameId);
      gameState.connectedSockets.set(playerId, socket.id);
    }

    // Update player connection status
    await supabase
      .from('players')
      .update({ is_connected: true, player_status: 'active' })
      .eq('id', playerId);

    console.log(`Player ${playerId} joined game ${gameId}`);
  });

  // Unity display joins game room
  socket.on('joinDisplayRoom', ({ gameId }) => {
    socket.join(gameId);
    console.log(`Display joined game ${gameId}`);
  });

  // Player submits answer
  socket.on('submitAnswer', async ({ gamePromptId, playerId, answerText, answerText2, answerText3 }) => {
    try {
      const { data, error } = await supabase
        .from('answers')
        .insert([{
          game_prompt_id: gamePromptId,
          player_id: playerId,
          answer_text: answerText,
          answer_text_2: answerText2 || null,
          answer_text_3: answerText3 || null,
          votes_received: 0,
          got_100_percent: false
        }])
        .select()
        .single();

      if (error) throw error;

      // Notify the player
      socket.emit('answerSubmitted', { success: true });

      // Optionally notify display that a player submitted
      const { data: gamePrompt } = await supabase
        .from('game_prompts')
        .select('game_id')
        .eq('id', gamePromptId)
        .single();

      io.to(gamePrompt.game_id).emit('playerSubmittedAnswer', { playerId });

    } catch (error) {
      console.error('Error submitting answer:', error);
      socket.emit('answerSubmitted', { success: false, error: error.message });
    }
  });

  // Player votes
  socket.on('submitVote', async ({ gamePromptId, voterId, answerId }) => {
    try {
      // Check if player already voted
      const { data: existingVote } = await supabase
        .from('votes')
        .select('*')
        .eq('game_prompt_id', gamePromptId)
        .eq('voter_id', voterId)
        .single();

      if (existingVote) {
        socket.emit('voteSubmitted', { success: false, error: 'Already voted' });
        return;
      }

      // Record vote
      const { error: voteError } = await supabase
        .from('votes')
        .insert([{
          game_prompt_id: gamePromptId,
          voter_id: voterId,
          answer_id: answerId
        }]);

      if (voteError) throw voteError;

      // Increment vote count on answer
      const { data: answer } = await supabase
        .from('answers')
        .select('votes_received')
        .eq('id', answerId)
        .single();

      await supabase
        .from('answers')
        .update({ votes_received: answer.votes_received + 1 })
        .eq('id', answerId);

      socket.emit('voteSubmitted', { success: true });

      // Notify display
      const { data: gamePrompt } = await supabase
        .from('game_prompts')
        .select('game_id')
        .eq('id', gamePromptId)
        .single();

      io.to(gamePrompt.game_id).emit('playerVoted', { voterId });

    } catch (error) {
      console.error('Error submitting vote:', error);
      socket.emit('voteSubmitted', { success: false, error: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Update player status if this was a player socket
    // (You'd need to track socket-to-player mapping for this)
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Quiplash server running on port ${PORT}`);
  console.log(`📊 Supabase connected: ${supabaseUrl}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Health check for Render
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Quiplash server is running',
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
