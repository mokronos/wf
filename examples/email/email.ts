import { defineStep, defineWorkflow, t } from "wf"

const SendEmailError = t.taggedStruct("SendEmailError", {
  message: t.string
})

const sendEmail = defineStep({
  name: "SendEmail",
  input: t.struct({ id: t.string, to: t.string, subject: t.string }),
  output: t.void,
  errors: SendEmailError,
  retry: { attempts: 5, backoff: "none" },
  execute: async (input, step) => {
    console.log(`SendEmail attempt ${step.attempt} -> ${input.to} | "${input.subject}"`)
    if (step.attempt !== 5) {
      throw new Error(`Failed to send email for ${input.id} on attempt ${step.attempt}`)
    }
  },
  compensate: async () => {
    console.log("Compensating SendEmail")
  }
})

export const EmailWorkflow = defineWorkflow({
  name: "EmailWorkflow",
  version: 1,
  input: t.struct({ id: t.string, to: t.string }),
  output: t.void,
  errors: SendEmailError,
  run: function* (input, ctx) {
    const subject = `Welcome, ${input.to.split("@")[0]}!`

    yield* ctx.run(sendEmail, {
      id: input.id,
      to: input.to,
      subject
    })

    yield* ctx.sleep("2 seconds", "cooldown")

    console.log("EmailWorkflow complete")
  }
})
