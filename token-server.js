/* eslint-disable no-console */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");

const PORT = 5000;
const DATA_DIR = path.join(__dirname, "data");
const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");

/**
 * @typedef {"Monitor"|"DJ"|"A"|"B"} IncomingAccount
 */

/**
 * @param {IncomingAccount} account
 * @returns {"Monitor"|"DJ"}
 */
function mapAccount(account) {
  if (account === "A") return "Monitor";
  if (account === "B") return "DJ";
  return account;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {any} body
 */
function validateBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "JSON body is required." };
  }

  const Token = body.Token;
  const refreshToken = body.refreshToken;
  const account = body.account;

  if (!isNonEmptyString(Token)) {
    return { ok: false, message: "Token is required and must be a non-empty string." };
  }
  if (!isNonEmptyString(refreshToken)) {
    return { ok: false, message: "refreshToken is required and must be a non-empty string." };
  }
  if (!isNonEmptyString(account)) {
    return { ok: false, message: "account is required and must be a non-empty string." };
  }

  const allowed = new Set(["Monitor", "DJ", "A", "B"]);
  if (!allowed.has(account)) {
    return { ok: false, message: "account must be one of Monitor/DJ/A/B." };
  }

  return { ok: true, Token, refreshToken, account };
}

async function readTokensFile() {
  try {
    const raw = await fs.readFile(TOKENS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function writeTokensFile(next) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const tmpPath = `${TOKENS_PATH}.tmp`;
  const data = JSON.stringify(next, null, 2);
  await fs.writeFile(tmpPath, data, "utf8");
  await fs.rename(tmpPath, TOKENS_PATH);
}

let writeLock = Promise.resolve();

/**
 * @param {any} update
 */
function enqueueUpdate(update) {
  writeLock = writeLock
    .then(async () => {
      const existing = await readTokensFile();
      const merged = { ...existing, ...update };
      await writeTokensFile(merged);
    })
    .catch(async (err) => {
      // lock chain should not be broken
      console.error("[token-server] write failed:", err);
      throw err;
    });

  return writeLock;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/update-token", async (req, res, next) => {
  try {
    const validated = validateBody(req.body);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, message: validated.message });
    }

    const mappedAccount = mapAccount(validated.account);
    const updatedAt = new Date().toISOString();

    console.log(`[${updatedAt}] /update-token account=${mappedAccount}`);

    await enqueueUpdate({
      [mappedAccount]: {
        Token: validated.Token,
        refreshToken: validated.refreshToken,
        updatedAt,
      },
    });

    return res.json({ ok: true, account: mappedAccount, updatedAt });
  } catch (err) {
    return next(err);
  }
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[token-server] error:", err);
  res.status(500).json({ ok: false, message: "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`[token-server] listening on http://localhost:${PORT}`);
  console.log(`[token-server] tokens file: ${TOKENS_PATH}`);
});
