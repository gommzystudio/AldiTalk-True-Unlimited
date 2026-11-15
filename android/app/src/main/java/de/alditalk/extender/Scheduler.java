package de.alditalk.extender;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

/**
 * Scheduling.
 *
 * JobScheduler refuses a periodic interval below 15 minutes, so anything
 * shorter is expressed as a one-shot job that the service re-arms when it
 * finishes. The chain alternates between two ids: scheduling or cancelling the
 * id that is currently executing would stop that very job, which would call
 * onStopJob again and spin.
 */
public final class Scheduler {

    private static final String TAG = "AldiTalkJob";

    public static final int JOB_PERIODIC = 1001;
    public static final int JOB_ALT = 1003;
    public static final int JOB_ONCE = 1002;

    /** JobScheduler's own floor for {@link JobInfo.Builder#setPeriodic(long)}. */
    private static final int MIN_PERIODIC_MINUTES = 15;

    private Scheduler() {
    }

    /** Idempotent: leaves an already correct schedule alone. */
    public static void ensurePeriodic(Context context) {
        JobScheduler scheduler = scheduler(context);
        if (scheduler == null) {
            return;
        }
        int minutes = Prefs.intervalMinutes(context);

        if (minutes >= MIN_PERIODIC_MINUTES) {
            JobInfo existing = scheduler.getPendingJob(JOB_PERIODIC);
            if (existing != null && existing.isPeriodic()
                    && existing.getIntervalMillis() == minutes * 60_000L) {
                return;
            }
            scheduler.cancel(JOB_PERIODIC);
            scheduler.cancel(JOB_ALT);
            scheduler.schedule(new JobInfo.Builder(JOB_PERIODIC, component(context))
                    .setPeriodic(minutes * 60_000L)
                    .setPersisted(true)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build());
            return;
        }

        // Chained mode: only start a chain if none is armed.
        if (scheduler.getPendingJob(JOB_PERIODIC) == null
                && scheduler.getPendingJob(JOB_ALT) == null) {
            scheduleNext(context, 0);
        }
    }

    /**
     * Arms the next check. {@code currentId} is the job that just produced a
     * result (0 when none), so the new job never replaces a running one.
     */
    public static void scheduleNext(Context context, int currentId) {
        JobScheduler scheduler = scheduler(context);
        if (scheduler == null) {
            return;
        }
        int minutes = Prefs.intervalMinutes(context);
        if (minutes >= MIN_PERIODIC_MINUTES) {
            // The periodic job re-arms itself; nothing to do here.
            return;
        }

        int id = currentId == JOB_PERIODIC ? JOB_ALT : JOB_PERIODIC;
        // Drop a leftover job from the other half of the chain, but never the one
        // that is executing right now - cancelling that stops it mid-run.
        int stale = id == JOB_PERIODIC ? JOB_ALT : JOB_PERIODIC;
        if (stale != currentId) {
            scheduler.cancel(stale);
        }
        long after = minutes * 60_000L;
        scheduler.cancel(id);
        int result = scheduler.schedule(new JobInfo.Builder(id, component(context))
                .setMinimumLatency(after)
                .setOverrideDeadline(after)
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build());
        Log.i(TAG, "Next check armed as job " + id + " in " + minutes + " min (result "
                + result + ")");
    }

    /** Run one check as soon as possible (boot, app update, "Run now"). */
    public static void scheduleOnce(Context context) {
        JobScheduler scheduler = scheduler(context);
        if (scheduler == null) {
            return;
        }
        scheduler.cancel(JOB_ONCE);
        JobInfo job = new JobInfo.Builder(JOB_ONCE, component(context))
                .setOverrideDeadline(2_000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build();
        scheduler.schedule(job);
    }

    /** Re-apply a changed interval. */
    public static void reschedule(Context context) {
        JobScheduler scheduler = scheduler(context);
        if (scheduler != null) {
            scheduler.cancel(JOB_PERIODIC);
            scheduler.cancel(JOB_ALT);
        }
        ensurePeriodic(context);
    }

    private static ComponentName component(Context context) {
        return new ComponentName(context, BookingJobService.class);
    }

    private static JobScheduler scheduler(Context context) {
        return (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    }
}
