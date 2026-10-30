package com.duochat.app

import android.app.Application
import com.duochat.app.notifications.DuoNotifications
import com.duochat.app.p2p.PeerConnectionFactoryHolder

class DuoChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DuoNotifications.ensureChannel(this)
        PeerConnectionFactoryHolder.initialize(this)
    }
}
