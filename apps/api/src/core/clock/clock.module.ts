import { Global, Module } from "@nestjs/common";
import { CLOCK_TOKEN } from "./clock.interface.js";
import { RealClock } from "./real-clock.js";
import { VirtualClock } from "./virtual-clock.js";

@Global()
@Module({
  providers: [
    {
      provide: CLOCK_TOKEN,
      useFactory: () => {
        if (process.env.SIM_MODE === "true") {
          return new VirtualClock();
        }
        return new RealClock();
      }
    }
  ],
  exports: [CLOCK_TOKEN]
})
export class ClockModule {}
