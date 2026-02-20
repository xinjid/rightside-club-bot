function shortError(error) {
  return String(error?.message || error || "Unknown error");
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
}

class DiscountScheduler {
  constructor({ db, smartshellClient, logger, emitToUi }) {
    this.db = db;
    this.smartshellClient = smartshellClient;
    this.logger = logger;
    this.emitToUi = emitToUi;
    this.intervalId = null;
    this.running = false;
  }

  start() {
    if (this.intervalId) {
      return;
    }
    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        const message = shortError(error);
        this.logger.error(`Discount scheduler tick failed: ${message}`);
      });
    }, 60 * 1000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const nowIso = new Date().toISOString();
      const scheduled = this.db.getDueScheduledJobs(nowIso);
      for (const job of scheduled) {
        await this.#activateJob(job);
      }

      const dueActive = this.db.getDueActiveJobs(nowIso);
      for (const job of dueActive) {
        await this.#finishJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  scheduleNow(payload) {
    const now = new Date();
    return this.db.createDiscountJob({
      clientUuid: payload.clientUuid,
      clientPhone: payload.clientPhone || null,
      clientNickname: payload.clientNickname || null,
      discountValue: toInt(payload.discountValue),
      previousDiscountValue: null,
      startsAt: now.toISOString(),
      endsAt: payload.endsAt,
      status: "scheduled",
      createdByTelegramUserId: payload.createdByTelegramUserId || "local",
    });
  }

  listJobs(limit = 15) {
    return this.db.listDiscountJobs(limit);
  }

  async cancelJob(jobId) {
    const job = this.db.getDiscountJobById(jobId);
    if (!job) {
      throw new Error("Job не найден");
    }

    if (job.status === "finished" || job.status === "failed" || job.status === "canceled") {
      return job;
    }

    if (job.status === "active") {
      const revertValue =
        job.previous_discount_value != null ? toInt(job.previous_discount_value) : 0;
      await this.smartshellClient.setUserDiscount(job.client_uuid, revertValue);
      this.logger.info(`Discount job reverted on cancel jobId=${job.id} value=${revertValue}`);
    }

    const updated = this.db.updateDiscountJob(job.id, {
      status: "canceled",
      lastError: null,
    });
    this.#emit(`Discount job canceled id=${updated.id} status=${updated.status}`);
    return updated;
  }

  async #activateJob(job) {
    try {
      let previous = job.previous_discount_value;
      if (previous == null) {
        const client = await this.smartshellClient.findClientByUuid(job.client_uuid);
        previous = client?.user_discount != null ? toInt(client.user_discount) : 0;
        this.db.updateDiscountJob(job.id, {
          previousDiscountValue: previous,
        });
      }

      await this.smartshellClient.setUserDiscount(job.client_uuid, toInt(job.discount_value));
      const updated = this.db.updateDiscountJob(job.id, {
        status: "active",
        previousDiscountValue: previous,
        lastError: null,
      });

      this.logger.info(
        `Discount job applied id=${updated.id} uuid=${updated.client_uuid} value=${updated.discount_value}`
      );
      this.#emit(`Discount job applied id=${updated.id} value=${updated.discount_value}%`);
    } catch (error) {
      const message = shortError(error);
      this.db.updateDiscountJob(job.id, {
        status: "failed",
        lastError: message,
      });
      this.logger.error(`Discount job apply failed id=${job.id}: ${message}`);
      this.#emit(`Discount job failed id=${job.id}: ${message}`);
    }
  }

  async #finishJob(job) {
    const revertValue =
      job.previous_discount_value != null ? toInt(job.previous_discount_value) : 0;

    try {
      await this.smartshellClient.setUserDiscount(job.client_uuid, revertValue);
      const updated = this.db.updateDiscountJob(job.id, {
        status: "finished",
        lastError: null,
      });
      this.logger.info(
        `Discount job finished id=${updated.id} uuid=${updated.client_uuid} revert=${revertValue}`
      );
      this.#emit(`Discount job finished id=${updated.id} revert=${revertValue}%`);
    } catch (error) {
      const message = shortError(error);
      this.db.updateDiscountJob(job.id, {
        status: "failed",
        lastError: message,
      });
      this.logger.error(`Discount job finish failed id=${job.id}: ${message}`);
      this.#emit(`Discount job finish failed id=${job.id}: ${message}`);
    }
  }

  #emit(text) {
    if (typeof this.emitToUi === "function") {
      this.emitToUi({
        role: "system",
        channel: "scheduler",
        initiator: "scheduler",
        text,
      });
    }
  }
}

module.exports = {
  DiscountScheduler,
};
