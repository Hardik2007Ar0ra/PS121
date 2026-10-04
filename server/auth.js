import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '8h';

function jwtSecret() {
  return process.env.JWT_SECRET || 'replace-this-demo-secret-before-production';
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

export function createUser(db, { name, email, password, role = 'viewer' }) {
  if (!name || !email || !password) {
    const error = new Error('name, email, and password are required');
    error.status = 400;
    throw error;
  }
  if (password.length < 8) {
    const error = new Error('password must be at least 8 characters');
    error.status = 400;
    throw error;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const error = new Error('email is already registered');
    error.status = 409;
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, email.toLowerCase(), bcrypt.hashSync(password, 10), role, new Date().toISOString());

  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

export function verifyLogin(db, { email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    const error = new Error('invalid email or password');
    error.status = 401;
    throw error;
  }
  return user;
}

export function requireAuth(db) {
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      const error = new Error('missing bearer token');
      error.status = 401;
      next(error);
      return;
    }

    try {
      const payload = jwt.verify(token, jwtSecret());
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user) {
        const error = new Error('user no longer exists');
        error.status = 401;
        next(error);
        return;
      }
      req.user = sanitizeUser(user);
      next();
    } catch {
      const error = new Error('invalid or expired token');
      error.status = 401;
      next(error);
    }
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      const error = new Error('insufficient role');
      error.status = 403;
      next(error);
      return;
    }
    next();
  };
}
