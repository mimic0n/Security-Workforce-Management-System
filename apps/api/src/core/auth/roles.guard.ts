import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@swms/contracts";
import { ROLES_KEY } from "./roles.decorator.js";
import { JwtPayload } from "./jwt-payload.interface.js";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;

    if (!user) {
      return true;
    }

    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.includes(user.role);
      if (!hasRole) {
        throw new ForbiddenException(`User role '${user.role}' lacks permission for this resource`);
      }
    }

    // Rule: Guards can only act on themselves
    if ((user.role === "GUARD" || user.role === "FLOAT") && request.params?.id) {
      const requestedId = parseInt(request.params.id, 10);
      if (!isNaN(requestedId) && user.guard_id !== null && user.guard_id !== requestedId) {
        throw new ForbiddenException("Guards can only access or modify their own data");
      }
    }

    return true;
  }
}
