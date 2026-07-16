import { run } from "@mokronos/wfkit"
import { EmailWorkflow } from "./email"

run(EmailWorkflow, { id: "123", to: "hello@timsmart.co" })
