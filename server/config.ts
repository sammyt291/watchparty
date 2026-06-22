import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    console.warn(error);
  }
}

export default {
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: Number(process.env.PORT ?? 8080),
  BUILD_DIRECTORY: process.env.BUILD_DIRECTORY ?? "build",
};
