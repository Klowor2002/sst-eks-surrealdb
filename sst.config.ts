import { SSTConfig } from "sst";
import { EksStack } from "./src/EksStack";
import { HonoStack } from "./src/HonoStack";

export default {
  config(_input) {
    return {
      name: "sst-eks-surrealdb",
      region: "us-east-1",
    };
  },
  stacks(app) {
    app.stack(EksStack);
    app.stack(HonoStack);
  },
} satisfies SSTConfig;
