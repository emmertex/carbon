# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# This app uses Capacitor SystemBars. Fail release builds if the unused Cordova
# implementation (and its deprecated navigation-bar color call) is retained.
-checkdiscard class org.apache.cordova.SystemBarPlugin

# Capgo initializes its notification channel ID with
# BackgroundGeolocationService.class.getPackage().getName(), even in the Play
# flavor where the service is removed from the manifest. Preserve this class's
# package/name so R8 cannot move it to the unnamed package (getPackage() is null
# on Android there). Members and unrelated classes can still be optimized.
-keep,allowshrinking class com.capgo.capacitor_background_geolocation.BackgroundGeolocationService
