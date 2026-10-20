import { Module } from "@nestjs/common";
import { DatabaseModule } from "./core/database/database.module.js";
import { AuthModule } from "./core/auth/auth.module.js";
import { GuardsModule } from "./modules/guards/guards.module.js";
import { PostsModule } from "./modules/posts/posts.module.js";

@Module({
  imports: [DatabaseModule, AuthModule, GuardsModule, PostsModule]
})
export class AppModule {}
