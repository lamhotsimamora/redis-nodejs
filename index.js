// server.js
const express = require('express');
const { createClient } = require('redis');
const morgan = require('morgan');
const cors = require('cors');
require('dotenv').config();
const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(cors());

// Konfigurasi Redis: ubah REDIS_URL jika perlu (e.g. redis://:password@host:port)
const REDIS_URL = process.env.REDIS_URL;
const client = createClient({ url: REDIS_URL });

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
  console.log('Connected to Redis:', REDIS_URL);
})();

// Key pattern:
// counter: "user:id" (string) -> next id (INCR)
// user hash: "user:{id}" -> fields: id, name, email, age
// set of ids: "users:ids" -> SADD/SREM for listing

const USER_ID_COUNTER = 'user:id';
const USERS_IDS_SET = 'users:ids';

function userKey(id) {
  return `user:${id}`;
}

// Create user
app.post('/users', async (req, res) => {
  try {
    const { name, email, age } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const id = await client.incr(USER_ID_COUNTER);
    const key = userKey(id);

    // store as hash; store age as string if present
    const userObj = { id: String(id), name, email };
    if (age !== undefined) userObj.age = String(age);

    await client.hSet(key, userObj);
    await client.sAdd(USERS_IDS_SET, String(id));

    const stored = await client.hGetAll(key);
    res.status(201).json(stored);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// Read all users (paginated optional)
app.get('/users', async (req, res) => {
  try {
    // optional pagination (page, limit)
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '100')));
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    // get all ids from set and slice for pagination
    const allIds = await client.sMembers(USERS_IDS_SET);
    const slice = allIds.slice(start, end + 1);

    // fetch each user
    const pipeline = client.multi();
    for (const id of slice) pipeline.hGetAll(userKey(id));
    const users = await pipeline.exec();
    // pipeline.exec() returns array of results; but node-redis multi returns array of replies as-is
    res.json({
      page,
      limit,
      total: allIds.length,
      users
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// Read single user
app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const key = userKey(id);
    const exists = await client.exists(key);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const user = await client.hGetAll(key);
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// Update user (partial)
app.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const key = userKey(id);
    const exists = await client.exists(key);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const update = {};
    const { name, email, age } = req.body;
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;
    if (age !== undefined) update.age = String(age);

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    await client.hSet(key, update);
    const user = await client.hGetAll(key);
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// Delete user
app.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const key = userKey(id);
    const exists = await client.exists(key);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    await client.del(key);
    await client.sRem(USERS_IDS_SET, String(id));
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
