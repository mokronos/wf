import { run } from "wf"
import { EmailWorkflow } from "./email"

run(EmailWorkflow, { id: "123", to: "hello@timsmart.co" })
