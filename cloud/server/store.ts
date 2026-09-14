import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export type Computer = { id: string; name: string; created: number }
export class Store {
  db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS computers(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);`)
  }
  computers(): Computer[] {
    return this.db.prepare('SELECT id,name,created FROM computers ORDER BY created').all() as Computer[]
  }
  addComputer(id: string, name: string) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !name.trim() || name.length > 120)
      throw new Error('A valid computer ID and name are required.')
    if (this.computers().some(c => c.id === id)) throw new Error('This computer is already connected.')
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO computers(id,name,token_hash,created) VALUES(?,?,?,?)').run(id, name.trim(), hash(token), Date.now())
    return { id, name: name.trim(), token }
  }
  connector(id: string, token: string) {
    return !!this.db.prepare('SELECT id FROM computers WHERE id=? AND token_hash=?').get(id, hash(token))
  }
  login() {
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token), Date.now() + 43_200_000)
    return token
  }
  authenticated(token: string) {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), Date.now())
  }
  logout(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token))
  }
  close() {
    this.db.close()
  }
}
