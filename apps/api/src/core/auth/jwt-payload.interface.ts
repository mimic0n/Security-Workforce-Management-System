import { UserRole } from "@swms/contracts";

export interface JwtPayload {
  sub: number;
  username: string;
  role: UserRole;
  guard_id: number | null;
}
