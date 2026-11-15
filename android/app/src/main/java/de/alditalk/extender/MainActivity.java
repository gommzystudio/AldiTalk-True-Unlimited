package de.alditalk.extender;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final int[] INTERVALS = {2, 15, 30, 60};

    private EditText userField;
    private EditText passField;
    private EditText thresholdField;
    private Spinner intervalSpinner;
    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        userField = findViewById(R.id.userField);
        passField = findViewById(R.id.passField);
        thresholdField = findViewById(R.id.thresholdField);
        intervalSpinner = findViewById(R.id.intervalSpinner);
        statusView = findViewById(R.id.statusView);

        userField.setInputType(InputType.TYPE_CLASS_PHONE);
        passField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        List<String> labels = new ArrayList<>();
        for (int minutes : INTERVALS) {
            labels.add(minutes + " minutes");
        }
        intervalSpinner.setAdapter(new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_dropdown_item, labels));
        intervalSpinner.setSelection(indexOf(Prefs.intervalMinutes(this)));

        SecretStore.Credentials stored = SecretStore.load(this);
        if (stored != null) {
            userField.setText(stored.user);
            passField.setText(stored.pass);
        }
        thresholdField.setText(String.valueOf(Prefs.thresholdMb(this)));

        Button save = findViewById(R.id.saveButton);
        Button runNow = findViewById(R.id.runNowButton);
        Button battery = findViewById(R.id.batteryButton);

        save.setOnClickListener(v -> saveAndSchedule());
        runNow.setOnClickListener(v -> {
            if (SecretStore.load(this) == null) {
                toast("Save your number and password first");
                return;
            }
            Scheduler.scheduleOnce(this);
            statusView.setText("Queued - a check will run shortly.");
        });
        battery.setOnClickListener(v -> requestBatteryExemption());

        requestNotificationPermission();
    }

    @Override
    protected void onResume() {
        super.onResume();
        statusView.setText(Status.get(this));
        if (SecretStore.load(this) != null) {
            Scheduler.ensurePeriodic(this);
        }
    }

    private void saveAndSchedule() {
        String user = userField.getText().toString().trim();
        String pass = passField.getText().toString();
        if (user.length() < 5 || pass.isEmpty()) {
            toast("Enter your phone number and password");
            return;
        }

        int threshold;
        try {
            threshold = Integer.parseInt(thresholdField.getText().toString().trim());
        } catch (NumberFormatException error) {
            toast("Remaining-data threshold must be a number of MB");
            return;
        }

        try {
            SecretStore.save(this, user, pass);
        } catch (RuntimeException error) {
            toast("Could not store the credentials: " + error.getMessage());
            return;
        }

        int minutes = INTERVALS[Math.max(0, intervalSpinner.getSelectedItemPosition())];
        Prefs.save(this, minutes, threshold);
        Scheduler.reschedule(this);
        Scheduler.scheduleOnce(this);

        toast("Saved - checking every " + minutes + " minutes");
        statusView.setText(Status.get(this));
    }

    private void requestBatteryExemption() {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception error) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private int indexOf(int minutes) {
        for (int i = 0; i < INTERVALS.length; i++) {
            if (INTERVALS[i] == minutes) {
                return i;
            }
        }
        return 0;
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }
}
