import { createServices } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { lateFeeJob } from "./jobs/late-fee-job.js";
import { notificationJobs } from "./jobs/notify-jobs.js";
import { Scheduler } from "./jobs/scheduler.js";

const config = loadConfig();
process.env.TZ = config.TZ;

const { app, prisma, notifier } = createServices(config);
app.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT}`);
});

// Exactly one process may run the scheduler (see SCHEDULER_ENABLED).
if (config.SCHEDULER_ENABLED ?? config.NODE_ENV === "production") {
  new Scheduler({ prisma, jobs: [lateFeeJob(prisma), ...notificationJobs(prisma, notifier)] }).start();
  console.log("scheduler started");
}
