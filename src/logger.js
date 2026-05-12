const fs = require("node:fs");
const path = require("node:path");

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = LEVELS[configuredLevel] || LEVELS.info;
const logDir = path.join(__dirname, "logs");
const logFile = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : path.join(logDir, "bot.log");

let fileLoggingEnabled = true;

function ensureLogFile() {
  if (!fileLoggingEnabled) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (error) {
    fileLoggingEnabled = false;
    console.error(
      `[${timestamp()}] [ERROR] Failed to create log directory ${path.dirname(logFile)} ${normalizeMeta({
        error: serializeError(error),
      })}`,
    );
  }
}

function timestamp() {
  return new Date().toISOString();
}

function normalizeMeta(meta) {
  if (!meta) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [meta_unserializable]";
  }
}

function write(level, message, meta) {
  if (LEVELS[level] < activeLevel) {
    return;
  }

  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}${normalizeMeta(meta)}`;
  writeToFile(line);

  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function writeToFile(line) {
  if (!fileLoggingEnabled) {
    return;
  }

  ensureLogFile();
  if (!fileLoggingEnabled) {
    return;
  }

  fs.appendFile(logFile, `${line}\n`, (error) => {
    if (!error) {
      return;
    }

    fileLoggingEnabled = false;
    console.error(
      `[${timestamp()}] [ERROR] Failed to write log file ${logFile} ${normalizeMeta({
        error: serializeError(error),
      })}`,
    );
  });
}

function serializeError(error) {
  if (!error) {
    return { message: "Unknown error" };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
  };
}

module.exports = {
  debug(message, meta) {
    write("debug", message, meta);
  },
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
  serializeError,
  logFile,
};
