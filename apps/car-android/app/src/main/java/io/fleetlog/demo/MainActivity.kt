package io.fleetlog.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.ViewModelProvider
import io.fleetlog.demo.ui.FleetLogScreen
import io.fleetlog.demo.ui.FleetLogViewModel

class MainActivity : ComponentActivity() {
    private lateinit var model: FleetLogViewModel
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[FleetLogViewModel::class.java]
        // Optional isolated mock server for a test device; never alters stored trips.
        intent.getStringExtra("mockApiEndpoint")?.let(model::setMockApiEndpoint)
        setContent { FleetLogScreen(model) }
    }

    override fun onResume() {
        super.onResume()
        if (::model.isInitialized) model.onAppForegrounded()
    }

    override fun onPause() {
        if (::model.isInitialized) model.onAppInactive()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        // No foreground/background service is claimed by this mock starter.
        if (!isChangingConfigurations && ::model.isInitialized) model.onAppBackgrounded()
    }
}
