package com.emmertex.carbon;

import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Android 15 (API 35) enforces edge-to-edge, so the WebView would otherwise
        // draw under the status bar and the navigation/gesture bar. Pad the content
        // view by the system-bar + display-cutout insets so the web app is kept
        // within the standard viewport on every device, including foldables when
        // unfolded. This covers all in-app overlays (sidebar/detail drawers, modals,
        // snackbar) in one place because the whole WebView is inset.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
