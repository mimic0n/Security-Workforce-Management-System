import { Module } from "@nestjs/common";
import { PostsService } from "./posts.service.js";
import { PostsController } from "./posts.controller.js";
import { AuthModule } from "../../core/auth/auth.module.js";

@Module({
  imports: [AuthModule],
  providers: [PostsService],
  controllers: [PostsController],
  exports: [PostsService]
})
export class PostsModule {}
