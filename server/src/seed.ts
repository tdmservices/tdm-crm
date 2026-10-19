import { db } from "./db.js";
import { hashPassword } from "./auth.js";

const users = [
  ["Abdul", "abdul@tdm.services", "owner", "revenue_share", 0.30],
  ["Adnan", "adnan@tdm.services", "manager", "revenue_share", 0.30],
  ["Haider", "haider@tdm.services", "agent", "revenue_share", 0.30],
  ["Hassaan", "hassaan@tdm.services", "agent", "profit_split", 0.50],
  ["Noman", "noman@tdm.services", "agent", "revenue_share", 0.30],
] as const;
const ins = db.prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role, commission_model, commission_rate) VALUES (?, ?, ?, ?, ?, ?)");
for (const [name, email, role, model, rate] of users) ins.run(name, email, hashPassword("Password123!"), role, model, rate);
console.log("Seeded users (password: Password123!):", users.map(u => u[1]).join(", "));
