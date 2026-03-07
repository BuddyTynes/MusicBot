const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = LEVELS[configuredLevel] || LEVELS.info;

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
};
