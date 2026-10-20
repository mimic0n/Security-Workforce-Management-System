import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards
} from "@nestjs/common";
import { PostsService } from "./posts.service.js";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import { CreatePostSchema, UpdatePostRuleSchema } from "@swms/contracts";

@Controller("posts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PostsController {
  constructor(@Inject(PostsService) private readonly postsService: PostsService) {}

  @Get()
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async findAll() {
    return this.postsService.findAll();
  }

  @Get(":id")
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async findOne(@Param("id") id: string) {
    return this.postsService.findOne(id);
  }

  @Post()
  @Roles("ADMIN")
  async create(@Body() body: any) {
    const dto = CreatePostSchema.parse(body);
    return this.postsService.create(dto);
  }

  @Patch(":id/rules")
  @Roles("ADMIN", "DISPATCHER", "MANAGER")
  async updateRules(@Param("id") id: string, @Body() body: any) {
    const dto = UpdatePostRuleSchema.parse(body);
    return this.postsService.updateRules(id, dto);
  }
}
