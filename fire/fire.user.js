// ==UserScript==
// @name        Flag Instantly, Rapidly, Effortlessly
// @namespace   https://github.com/Charcoal-SE/
// @description FIRE adds a button to SmokeDetector reports that allows you to provide feedback & flag, all from chat.
// @author      Cerbrus
// @attribution Michiel Dommerholt (https://github.com/Cerbrus)
// @version     0.6.5
// @updateURL   https://raw.githubusercontent.com/Charcoal-SE/Userscripts/master/fire/fire.user.js
// @downloadURL https://raw.githubusercontent.com/Charcoal-SE/Userscripts/master/fire/fire.user.js
// @supportURL  https://github.com/Charcoal-SE/Userscripts/issues
// @match       *://chat.stackexchange.com/rooms/11540/charcoal-hq
// @match       *://chat.stackoverflow.com/rooms/41570/so-close-vote-reviewers
// @match       *://chat.meta.stackexchange.com/rooms/89/tavern-on-the-meta
// @grant       none
// ==/UserScript==
/* global fire, metapi, toastr, CHAT, GM_info */
/* eslint-disable camelcase */

(function () {
  "use strict";

  (function (scope) { // Init
    var hOP = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);

    var smokeDetectorId = { // this is Smokey's user ID for each supported domain
      "chat.stackexchange.com": 120914,
      "chat.stackoverflow.com": 3735529,
      "chat.meta.stackexchange.com": 266345,
    }[location.host];       // From which, we need the current host's ID

    var defaultLocalStorage = {
      blur: true,
      flag: true,
      toastrPosition: "top-right",
      toastrDuration: 2500,
      readOnly: false
    };

    scope.fire = {
      metaData: GM_info.script || GM_info["Flag Instantly, Rapidly, Effortlessly"],
      openReportPopup: openReportPopupForMessage,
      emoji: {fire: "🔥", user: "👤", gear: "⚙️"},
      api: {
        ms: {
          key: "55c3b1f85a2db5922700c36b49583ce1a047aabc4cf5f06ba5ba5eff217faca6", // this script's MetaSmoke API key
          url: "https://metasmoke.erwaysoftware.com/api/"
        },
        se: {
          key: "NDllMffmzoX8A6RPHEPVXQ((", // this script's Stack Exchange API key
          url: "https://api.stackexchange.com/2.2/"
        }
      },
      smokeDetectorId: smokeDetectorId,
      SDMessageSelector: ".user-" + smokeDetectorId + " .message ",
      buttonKeyCodes: [],
      reportCache: {}
    };

    registerLoggingFunctions(false);

    hasEmojiSupport();
    initLocalStorage(hOP, defaultLocalStorage);
    getCurrentUser();
    loadStackExchangeSites();
    injectExternalScripts();
    showFireOnExistingMessages();
    registerAnchorHover();
    registerWebSocket();
    registerOpenLastReportKey();
    CHAT.addEventHandlerHook(chatListener);
  })(window);

  // Loads MetaSmoke data for a specified post url
  function getDataForUrl(reportedUrl, callback) {
    var ms = fire.api.ms;
    var url = ms.url + "posts/urls?key=" + ms.key + "&page=1&urls=" + reportedUrl;
    $.get(url, function (data) {
      if (data && data.items) {
        callback(data.items[0]);
      }
    });
  }

  // Checks if the list of users on this flag report contains the current user.
  function listHasCurrentUser(flags) {
    return flags &&
      flags.users.some(function (u) {
        return u.username === fire.chatUser.name;
      });
  }

  // Loads a report's data when you hover over the FIRE button.
  function loadDataForReport(openAfterLoad) {
    var $this = $(this);
    var url = $this.data("url");

    if (!fire.reportCache[url]) {
      getDataForUrl(url, function (data) {
        data.is_answer = data.link.indexOf("/a/") >= 0;
        data.site = data.link.split(".com")[0].replace(/\.stackexchange|\/+/g, "");
        data.is_deleted = data.deleted_at !== null;

        data.has_auto_flagged = listHasCurrentUser(data.autoflagged) && data.autoflagged.flagged;
        data.has_manual_flagged = listHasCurrentUser(data.manual_flags);
        data.has_flagged = data.has_auto_flagged || data.has_manual_flagged;

        data.has_sent_feedback = data.feedbacks.some(function (f) { // Feedback has been sent already
          return f.user_name === fire.chatUser.name;
        });

        fire.reportCache[url] = data; // Store the data

        fire.log("Loaded report data", data);

        if (openAfterLoad === true) {
          $this.click();
        }
      });
    } else if (openAfterLoad === true) {
      $this.click();
    }
  }

  // Loads a list of all Stack Exchange Sites.
  function loadStackExchangeSites() {
    var now = new Date().valueOf();
    var sites = fire.sites;

    // If there are no sites or the site data is over 7 days
    if (!sites || sites.storedAt < (now - 604800000)) { // 604800000 ms is 7 days (7 * 24 * 60 * 60 * 1000)
      sites = {};                                       // Clear the site data
    }

    if (!sites.storedAt) { // If the site data is empy
      var se = fire.api.se;
      var url = se.url + "sites?key=" + se.key + "&filter=!Fn4IB7S7Yq2UJF5Bh48LrjSpTc&pagesize=10000";

      $.get(url, function (response) {
        for (var i = 0; i < response.items.length; i++) {
          var item = response.items[i];
          sites[item.api_site_parameter] = item;
        }

        sites.storedAt = now; // Set the storage timestamp
        fire.sites = sites;   // Store the site list

        fire.log("Loaded Stack Exchange sites");
      });
    }
  }

  // Gets a MetaSmoke write token
  function getWriteToken(callback) {
    setValue("readOnly", false);
    var afterGetToken = callback;

    writeTokenPopup(function (metaSmokeCode) {
      if (metaSmokeCode && metaSmokeCode.length === 7) {
        $.ajax({
          url: "https://metasmoke.erwaysoftware.com/oauth/token?key=" + fire.api.ms.key + "&code=" + metaSmokeCode,
          method: "GET"
        }).done(function (data) {
          setValue("metasmokeWriteToken", data.token);
          toastr.success("Successfully obtained MetaSmoke write token!");
          closePopup();

          if (afterGetToken) {
            afterGetToken();
          }
        }).error(function (jqXHR) {
          if (jqXHR.status === 404) {
            toastr.error("Metasmoke could not find a write token - did you authorize the app?");
          } else {
            toastr.error("An unknown error occurred during OAuth with metasmoke.");
          }
        });
      } else {
        setValue("readOnly", true);
        toastr.info("FIRE is not in read-only mode.");
        closePopup();

        if (afterGetToken) {
          afterGetToken();
        }
      }
    });
  }

  // Chat message event listener. If SmokeDetector reports another post, decorate the message
  function chatListener(e) {
    if (e.event_type === 1 && e.user_id === fire.smokeDetectorId) {
      setTimeout(function () {
        var message = $("#message-" + e.message_id);
        decorateMessage(message);
      });
    }
  }

  // Adds the "FIRE" button to the passed message
  function decorateMessage(message) {
    var m = $(message);
    if (m.find(".fire-button").length === 0) {
      var anchors = m.find(".content a");

      var reportLink = filterOnContents(anchors, "MS");
      var urlOnReportLink = true;

      if (reportLink.length === 0) {
        reportLink = filterOnContents(anchors, "SmokeDetector");
        urlOnReportLink = false;
      }

      if (reportLink.length > 0) { // This is a report
        var reportedUrl;
        if (urlOnReportLink) {
          reportedUrl = reportLink[0].href.split("url=").pop();
        } else {
          reportedUrl = reportLink.nextAll("a")[0].href.replace(/https?:/, "");
        }

        if (!reportedUrl.startsWith("//github.com") && reportedUrl.indexOf("erwaysoftware.com") === -1) {
          var fireButton = _("span", "fire-button", {
            html: emojiOrImage("fire"),
            click: openReportPopup
          })
          .data("url", reportedUrl);

          reportLink
            .after(fireButton)
            .after(" | ");
        }
      }
    }
  }

  // Filter a jQuery list on the element text.
  function filterOnContents($object, text) {
    return $object.filter(function () {
      return $(this).text() === text;
    });
  }

  // Set the toastr class
  function toastrPositionChangeHandler() {
    var value = $(this).val();

    var data = fire.userData;
    data.toastrPosition = value;
    toastr.options.positionClass = "toast-" + value;

    $("#toast-container").remove();
    toastr.info("Notification position updated.");
    fire.userData = data;
  }

  // Update the toastr duration
  function toastrDurationHandler() {
    var value = $(this).val();

    var data = fire.userData;
    data.toastrDuration = value;
    toastr.options.timeOut = value;

    $("#toast-container").remove();
    fire.userData = data;
  }

  // Set the "Blur" option
  function blurOptionClickHandler() {
    var value = $(this).is(":checked");

    var data = fire.userData;
    data.blur = value;
    $("#container").toggleClass("fire-blur", data.blur);
    toastr.info("Blur " + (data.blur ? "en" : "dis") + "abled.");
    fire.userData = data;
  }

  // Set the "Flag" option
  function flagOptionClickHandler() {
    var value = $(this).is(":checked");

    var data = fire.userData;
    data.flag = value;
    toastr.info("Flagging on \"tpu-\" feedback " + (data.flag ? "en" : "dis") + "abled.");
    fire.userData = data;
  }

  // Handle keypress events for the popup
  function keyboardShortcuts(e) {
    if (e.keyCode === 13 || e.keyCode === 32) { // [Enter] key or spacebar
      e.preventDefault();
      $(".fire-popup-header a.button.focus")
        .fadeOut(100)           // Flash to indicate which button was selected.
        .fadeIn(100, function () {
          $(this).click();
        });
    } else if (fire.buttonKeyCodes.indexOf(e.keyCode) >= 0 && !fire.settingsAreOpen) {
      e.preventDefault();

      $(".fire-popup-header a.button")
        .removeClass("focus")
        .trigger("mouseleave");

      var $button = $(".fire-popup-header a[fire-key=" + e.keyCode + "]:not([disabled])");
      var button = $button[0];

      if (button) {
        if (e.keyCode === 27) { // [Esc] key
          $button.click();
        } else if (e.keyCode === 53) { // [5]: Open the report on the site
          window.open(button.href);
        } else {                // [1-4] keys for feedback buttons
          var pos = button.getBoundingClientRect();
          $button
            .addClass("focus")
            .trigger("mouseenter")
            .trigger($.Event("mousemove", { // eslint-disable-line new-cap
              clientX: pos.right - (button.offsetWidth + 20),
              clientY: pos.top + 20
            }));
        }
      }
    } else if (fire.settingsAreOpen && e.keyCode === 27) {
      closePopup();
    }
  }

  var clickHandlers = {
    requestToken: function () {
      window.open("https://metasmoke.erwaysoftware.com/oauth/request?key=" + fire.api.ms.key, "_blank");
    },
    saveToken: function (input, callback) {
      var value = input.val();
      if (value && value.length === 7) {
        callback(value);
      }
    },
    disableReadonly: function () {
      closePopup();
      closePopup();
      getWriteToken();
    }
  };

  // Open a popup to enter the write token
  function writeTokenPopup(callback) {
    var w = (window.innerWidth - $("#sidebar").width()) / 2;
    var input = _("input", "fire-popup-input", {
      type: "text",
      maxlength: "7",
      placeholder: "Enter code here"
    });

    _("div", "fire-popup-modal")
      .appendTo("body")
      .click(closePopup);

    _("div", "fire-popup")
      .css({top: "5%", left: w - 300})
      .append(
        _("div", "fire-popup-header")
          .append(_("p", {
            html: "FIRE requires a MetaSmoke write token to submit feedback.<br />" +
                  "This requires that your MetaSmoke account has the \"Reviewer\" role. <br />" +
                  "Once you've authenticated FIRE with MetaSmoke, you'll be given a code.<br />"
          }))
          .append(button("Request Token", clickHandlers.requestToken))
          .append(input)
          .append(button("Save", function () {
            clickHandlers.saveToken(input, callback);
          }))
          .append(_("br"))
          .append(_("br"))
          .append(_("p", {
            html: "Alternatively, if you're not a \"Reviewer\", you can run FIRE in read-only mode by disabling feedback.<br />" +
                  "You will still be able to view reports."
          }))
          .append(button("Disable feedback", callback))
      )
      .hide()
      .appendTo("body")
      .fadeIn("fast");

    $("#container").toggleClass("fire-blur", fire.userData.blur);

    $(document).keydown(keyboardShortcuts);
  }

  // Opens a report popup for a specific message
  function openReportPopupForMessage(message) {
    loadDataForReport.call(
      $(message).find(".fire-button"),
      true
    );
  }

  // Build a popup and show it.
  function openReportPopup() {
    if (fire.isOpen && $(".fire-popup").length > 0) {
      return; // Don't open the popup twice.
    }

    var that = this;

    if (!fire.userData.metasmokeWriteToken && !fire.userData.readOnly) {
      getWriteToken(function () {
        openReportPopup.call(that); // Open the popup later
      });
      return;
    }

    fire.isOpen = that;

    var $that = $(that);
    var url = $that.data("url");
    var d;

    if (url && fire.reportCache[url] && !fire.reportCache[url].isExpired) {
      d = fire.reportCache[url];
    } else {
      loadDataForReport.call(that, true); // No data, so load it.
    }

    if (typeof d === "undefined") {
      console.log("Sometimes, d seems to be undefined", $that, d);
    }

    var w = (window.innerWidth - $("#sidebar").width()) / 2;
    var site = fire.sites[d.site];

    var popup = _("div", "fire-popup" + (fire.userData.readOnly ? " fire-readonly" : ""))
      .css({top: "5%", left: w - 300});

    var openOnSiteButton = _("a", "fire-site-logo", {
      html: site ? site.name : d.site,
      href: d.link,
      target: "_blank",
      css: {"background-image": "url(" + (site ? site.icon_url : "//cdn.sstatic.net/Sites/" + d.site + "/img/apple-touch-icon.png") + ")"},
      "fire-key": 53,
      "fire-tooltip": "Show on site"
    });

    var top = _("p", "fire-popup-header");

    if (!fire.userData.readOnly) {
      top
        .append(createFeedbackButton(d, 49, "tpu-", "tpu-", "True positive"))
        .append(createFeedbackButton(d, 50, "tp-", "tp-", "Vandalism"))
        .append(createFeedbackButton(d, 51, "naa-", "naa-", "Not an Answer / VLQ"))
        .append(createFeedbackButton(d, 52, "fp-", "fp-", "False Positive"));
    }

    top
      .append(openOnSiteButton)
      .append(createCloseButton(closePopup));

    var postType = d.is_answer ? "Answer" : "Question";
    var body = _("div", "fire-popup-body")
      .append(_("h2")
        .append(_("em", {html: d.title, title: "Question Title"}))
      )
      .append(_("hr"))
      .append(
        _("div", "fire-report-info", {title: "Click to show reason"})
          .click(function () {
            $(this).toggleClass("fire-show-reason");
          })
          .append(_("h3", "fire-type", {
            text: postType + ":"
          }))
          .append(
            _("span", "fire-username", {
              text: d.username + " ",
              title: "Username"
            })
            .append(emojiOrImage("user")))
          .append(_("span", "fire-reason", {
            text: "The reported post is a" + (d.is_answer ? "n " : " ") + postType.toLowerCase() +
                  "\nReason weight: " + d.reason_weight + "\n" +
                  d.why
          }))
      )
      .append(_("div", "fire-reported-post" + (d.is_deleted ? " fire-deleted" : ""))
        .append(d.body.replace(/<script/g, "&lt;script"))
      );

    body.find("pre code").each(function () {
      this.innerHTML = this.innerHTML
        .replace(/>/g, "&gt;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    });

    _("div", "fire-popup-modal")
      .appendTo("body")
      .click(closePopup);

    var settingsButton = _("a", "fire-settings-button", {
      html: emojiOrImage("gear"),
      title: "FIRE Configuration",
      click: openSettingsPopup
    });

    popup
      .append(top)
      .append(body)
      .append(settingsButton)
      .hide()
      .appendTo("body")
      .fadeIn("fast");

    $("#container").toggleClass("fire-blur", fire.userData.blur);

    expandLinksOnHover();

    $(document).keydown(keyboardShortcuts);
    $(document).on("click", ".fire-popup-body pre", function () {
      $(this).toggleClass("fire-expanded");
    });
  }

  // Opens a popup to change fire's settings
  function openSettingsPopup() {
    if (fire.settingsAreOpen) {
      return; // Don't open the settings twice.
    }
    fire.settingsAreOpen = true;

    // var that = this;
    // var $that = $(that);
    var w = (window.innerWidth - $("#sidebar").width()) / 2;
    var popup = _("div", "fire-popup", {
      id: "fire-settings"
    })
    .css({top: "5%", left: w - 300});

    var top = _("p", "fire-popup-header")
      .append(
        _("h2")
          .append(emojiOrImage("fire", true))
          .append(" FIRE settings."))
      .append(createCloseButton(closePopup));

    var toastDurationElements = _("div")
      .append(
        _("span", {
          text: "Notification popup duration:"
        })
        .append(_("br"))
        .append(_("input", {
          id: "toastr_duration",
          type: "number",
          value: fire.userData.toastrDuration,
          change: toastrDurationHandler,
          blur: function () {
            toastr.info("Notification duration updated");
          }
        }))
        .append(" ms")
      );

    var toastrClasses = ["top-right", "bottom-right", "bottom-left", "top-left", "top-full-width", "bottom-full-width", "top-center", "bottom-center"];
    var selected = fire.userData.toastrPosition;

    var positionSelect = _("select", "fire-position-select", {
      change: toastrPositionChangeHandler
    });

    for (var i = 0; i < toastrClasses.length; i++) {
      var val = toastrClasses[i];
      positionSelect.append(
        _("option", {
          value: val,
          text: val.replace(/-/g, " "),
          selected: val === selected
        })
      );
    }

    var disableReadonly = $();
    if (fire.userData.readOnly) {
      disableReadonly = _("br").after(
        button("Disable read-only mode", clickHandlers.disableReadonly)
      );
    }

    var positionSelector = _("div")
      .append(_("br"))
      .append(
        _("span", {text: "Notification popup position:"})
          .append(_("br"))
          .append(positionSelect)
        );

    var container = _("div")
      .append(
        _("div", "fire-settings-section fire-settings-left")
          .append(createSettingscheckBox("blur", fire.userData.blur, blurOptionClickHandler,
            "Enable blur on popup background.",
            "Popup blur:"
          ))
          .append(_("br"))
          .append(createSettingscheckBox("flag", fire.userData.flag, flagOptionClickHandler,
            "Also submit \"Spam\" flag with \"tpu-\" feedback.",
            "Flag on feedback:")
          )
          .append(disableReadonly)
      )
      .append(
        _("div", "fire-settings-section fire-settings-right")
          .append(_("h3", {text: "Notifications:"}))
          .append(toastDurationElements)
          .append(positionSelector)
      );

    popup
      .append(top)
      .append(container)
      .hide()
      .appendTo("body")
      .fadeIn("fast");
  }

  // Close the popup
  function closePopup() {
    fire.sendingFeedback = false;
    if (fire.settingsAreOpen) {
      $(".fire-popup#fire-settings")
        .fadeOut("fast", function () {
          $(this).remove();
        });

      delete fire.settingsAreOpen;
    } else {
      $(".fire-popup, .fire-popup-modal")
        .fadeOut("fast", function () {
          $(this).remove();
        });

      $(document).off("keydown", keyboardShortcuts);

      $("#container").removeClass("fire-blur");

      var previous = fire.isOpen;
      delete fire.isOpen;

      return previous; // Return the previously closed popup's button so it can be re-opened
    }
  }

  // Submit MS feedback
  function postMetaSmokeFeedback(data, verdict) {
    if (!fire.sendingFeedback) {
      fire.sendingFeedback = true;

      var ms = fire.api.ms;
      var token = fire.userData.metasmokeWriteToken;
      if (data.has_sent_feedback) {
        var message = span("You have already sent feedback to MetaSmoke for this report.");
        if (verdict === "tpu-") {
          postMetaSmokeSpamFlag(data, ms, token, message.after("<br /><br />"));
        } else {
          toastr.info(message);
          closePopup();
        }
      } else {
        $.ajax({
          type: "POST",
          url: ms.url + "w/post/" + data.id + "/feedback",
          data: {type: verdict, key: ms.key, token: token}
        }).done(function () {
          var message = span("Sent feedback \"<em>" + verdict + "\"</em> to metasmoke.");
          if (verdict === "tpu-" && fire.userData.flag) {
            postMetaSmokeSpamFlag(data, ms, token, message.after("<br /><br />"));
          } else {
            toastr.success(message);
            closePopup();
          }
        }).error(function (jqXHR) {
          if (jqXHR.status === 401) {
            toastr.error("Can't send feedback to metasmoke - not authenticated.");

            clearValue("metasmokeWriteToken");
            var previous = closePopup();

            getWriteToken(function () {
              openReportPopup.call(previous); // Open the popup later
            });
          } else {
            toastr.error("An error occurred sending post feedback to metasmoke.");
            console.error("An error occurred sending post feedback to metasmoke.", jqXHR);
          }
        }).always(function () {
          fire.sendingFeedback = false;
        });
      }
    }
  }

  // Flag the post as spam
  function postMetaSmokeSpamFlag(data, ms, token, feedbackSuccess) {
    if (data.has_auto_flagged) {
      toastr.info(feedbackSuccess.after(span("You already autoflagged this post as spam.")));
    } else if (data.has_manual_flagged) {
      toastr.info(feedbackSuccess.after(span("You already flagged this post as spam.")));
    } else if (data.is_deleted) {
      toastr.info(feedbackSuccess.after(span("The reported post can't be flagged: It is already deleted.")));
    } else {
      $.ajax({
        type: "POST",
        url: ms.url + "w/post/" + data.id + "/spam_flag",
        data: {key: ms.key, token: token}
      }).done(function (response) {
        toastr.success(feedbackSuccess.after(span("Successfully flagged the post as \"spam\".")));
        closePopup();

        if (response.backoff) {
          // We've got a backoff. Deal with it...
          // Yea, this isn't implemented yet. probably gonna set a timer for the backoff and
          // re-execute any pending requests that were submitted during that time, afterwards.
          debugger; // eslint-disable-line no-debugger
          toastr.info("Backoff received");
          console.info(data, response);
        }
      }).error(function (jqXHR) {
        toastr.success("Sent feedback \"<em>tpu-\"</em> to metasmoke."); // We came from a "feedback" success handler.

        if (jqXHR.status === 409) {
          // https://metasmoke.erwaysoftware.com/authentication/status
          // will give you a 409 response with error_name, error_code and error_message parameters if the user isn't write-authenticated;
          toastr.error(
            "FIRE requires your MetaSmoke account to be write-authenticated with Stack Exchange in order to submit spam flags.<br />" +
            "Your MetaSmoke account doesn't appear to be write-authenticated.<br />" +
            "Please open <em><a href='https://metasmoke.erwaysoftware.com/authentication/status' target='_blank'>this page</a></em> to authenticate with Stack Exchange.",
            null,
            {timeOut: 0, extendedTimeOut: 1000, progressBar: true});
          console.error(data, jqXHR);
        } else {
          if (jqXHR.responseText) {
            var response = JSON.parse(jqXHR.responseText);

            if (response.message === "Spam flag option not present") {
              toastr.info("This post could not be flagged.<br />" +
                "It is probably deleted already.");
              closePopup();
              return;
            }
          }

          // will give you a 500 with status: 'failed' and a message if the spam flag fails;
          toastr.error("Something went wrong while attempting to submit a spam flag");
          console.error(data, jqXHR);
          fire.sendingFeedback = false;
        }
      });
      return;
    }
    closePopup();
  }

  // Create a feedback button for the top of the popup
  function createFeedbackButton(data, keyCode, text, verdict, tooltip) { // eslint-disable-line max-params
    var count;
    var hasSubmittedFeedback;

    if (data.feedbacks) { // Has feedback
      count = data.feedbacks.filter(function (f) {
        return f.feedback_type === verdict;
      }).length;
      hasSubmittedFeedback = data.feedbacks.some(function (f) {
        return f.feedback_type === verdict &&
          f.user_name === fire.chatUser.name;
      });
    }

    var suffix = count ? " (" + count + ")" : "";
    var cssClass = hasSubmittedFeedback ? " fire-submitted" : "";

    return _("a", "button fire-feedback-button fire-" + verdict + cssClass, {
      text: text + suffix,
      click: function () {
        if (!data.has_sent_feedback ||
          (fire.userData.flag && !(data.has_flagged || data.is_deleted))
        ) {
          postMetaSmokeFeedback(data, verdict);
        } else {
          var performedAction;
          if (data.has_flagged) {
            performedAction = "flagged";
          } else if (data.is_deleted) {
            performedAction = "flagged";
          }

          toastr.info(
            "You have already sent feedback for this reported post.<br />" +
            "The post has already been " + performedAction + ".",
            null, {
              preventDuplicates: true
            });
        }
      },
      disabled: data.has_sent_feedback && (data.has_flagged || data.is_deleted || !fire.userData.flag),
      "fire-key": keyCode,
      "fire-tooltip": tooltip + suffix
    });
  }

  // Create a button to close a popup
  function createCloseButton(clickHandler) {
    return _("a", "button fire-close-button", {
      text: "Close",
      title: "Close this popup",
      click: clickHandler,
      "fire-key": 27 // escape key code
    });
  }

  // Creates a input[type=checkbox] for the settings
  function createSettingscheckBox(id, value, handler, labelText, headerText) { // eslint-disable-line max-params
    var checkBox = _("input", {
      id: "checkbox_" + id,
      type: "checkbox",
      checked: value,
      click: handler
    });

    var label = _("label", {
      for: "checkbox_" + id,
      text: labelText
    });

    return _("div")
      .append(_("h3", {text: headerText}))
      .append(checkBox)
      .append(label);
  }

  // Wrapper to create a new element with a specified class.
  function _(tagName, cssClass, options) {
    if (typeof cssClass === "object") {
      options = cssClass;
      cssClass = undefined;
    }

    options = options || {};
    options.class = cssClass;

    if (options["fire-key"]) {
      fire.buttonKeyCodes.push(options["fire-key"]);
    }

    return $("<" + tagName + "/>", options);
  }

  // Create a `<span>` with the specified contents.
  function span(contents) {
    return _("span", {html: contents});
  }

  // Create a button
  function button(text, clickHandler) {
    return _("a", "button", {
      text: text,
      click: clickHandler
    });
  }

  // Detect Emoji support in this browser
  function hasEmojiSupport() {
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d");
    var smiley = String.fromCodePoint(0x1F604); // :smile: String.fromCharCode(55357) + String.fromCharCode(56835)

    ctx.textBaseline = "top";
    ctx.font = "32px Arial";
    ctx.fillText(smiley, 0, 0);

    fire.useEmoji = ctx.getImageData(16, 16, 1, 1).data[0] !== 0;

    fire.log("Emoji support detected:", fire.useEmoji);
  }

  // Returns the emoji if it's supported. Otherwise, return a fallback image.
  function emojiOrImage(emoji, large) {
    emoji = fire.emoji[emoji] || emoji;

    if (fire.useEmoji) {
      return $(document.createTextNode(emoji));
    }

    var url = "https://raw.githubusercontent.com/Ranks/emojione/master/assets/png/";
    var hex = emoji.codePointAt(0).toString(16);

    var emojiImage = _("img", "fire-emoji" + (large ? "-large" : ""), {
      src: url + hex + ".png",
      alt: emoji
    });

    return emojiImage;
  }

  // Inject FIRE stylesheet and Toastr library
  function injectExternalScripts() {
    injectCSS("//charcoal-se.org/userscripts/fire/fire.css?v=" + fire.metaData.version);

    if (typeof toastr === "undefined") {
      // toastr is a Javascript library for non-blocking notifications.
      var path = "//cdnjs.cloudflare.com/ajax/libs/toastr.js/latest/";
      injectCSS(path + "toastr.min.css");
      $.getScript(path + "/toastr.min.js").then(toastrOptions);
    }

    fire.log("Injected scripts and stylesheets.");
  }

  // Inject the specified stylesheet
  function injectCSS(path) {
    var css = window.document.createElement("link");
    css.rel = "stylesheet";
    css.href = path;
    document.head.appendChild(css);
  }

  // Set toastr options
  function toastrOptions() {
    toastr.options = {
      closeButton: true,
      progressBar: true,
      positionClass: "toast-" + fire.userData.toastrPosition,
      preventDuplicates: false, // If we send feedback twice, show 2 notifications, even if they're duplicates.
      timeOut: fire.userData.toastrDuration,
      hideDuration: 250,
      extendedTimeOut: 500,
    };

    fire.log("Toastr included, notification options set.");
  }

  // Open the last report on [Ctrl]+[Space]
  function registerOpenLastReportKey() {
    $(document).on("keydown", function (e) {
      if (e.keyCode === 32 && e.ctrlKey) {
        var button = $(".fire-button").last(); // .content:not(.ai-deleted)
        if (button && button.length > 0) {
          loadDataForReport.call(button, true);
        }
      }
    });

    fire.log("Registered \"Open last report\" key.");
  }

  // Register the "tooltip" hover for anchor elements
  function registerAnchorHover() {
    var anchorSelector = "a[fire-tooltip]";
    $("body")
      .on("mouseenter", anchorSelector, function () {
        $(".fire-tooltip").remove();
        var that = $(this);
        that.after(_("span", "fire-tooltip", {
          text: that.attr("fire-tooltip")
        }));
      }).on("mousemove", anchorSelector, function (e) {
        $(".fire-tooltip").css({
          left: e.clientX + 20,
          top: e.clientY + 5
        });
      })
      .on("mouseleave", anchorSelector, function () {
        $(".fire-tooltip").remove();
      });

    fire.log("Registered anchor hover tooltip.");
  }

  // Register a websocket listener
  function registerWebSocket() {
    $.ajaxSetup({cache: true});
    $.getScript("//charcoal-se.org/userscripts/metapi.js?v=" + fire.metaData.version)
      .then(function () {
        metapi.watchSocket(fire.api.ms.key, socketOnMessage);
        $.ajaxSetup({cache: false});

        fire.log("Websocket initialized.");
      });
  }

  // Adds a property on `fire` that's stored in `localStorage`
  function registerForLocalStorage(object, key, localStorageKey) {
    Object.defineProperty(object, key, {
      get: function () {
        return JSON.parse(localStorage.getItem(localStorageKey));
      },
      set: function (value) {
        localStorage.setItem(localStorageKey, JSON.stringify(value));
      }
    });
  }

  // Registers logging functions on `fire`
  function registerLoggingFunctions(debug) {
    fire.debug = debug;
    fire.log = getLogger("log");
    fire.info = getLogger("info");
    fire.warn = getLogger("warn");
    fire.error = getLogger("error");

    if (fire.debug) {
      fire.info("Debug mode enabled.");
    }
  }

  // Adds the "FIRE" button to all existing messages and registers an event listener to do so after "load older messages" is clicked
  function showFireOnExistingMessages() {
    $("#getmore, #getmore-mine")
      .click(function () {
        decorateExistingMessages(500);
      });

    decorateExistingMessages(0);

    // Load report data on fire button hover
    $("body").on("mouseenter", ".fire-button", loadDataForReport);

    fire.log("Registered loadDataForReport");
  }

  // Decorate messages that exist on page load
  function decorateExistingMessages(timeout) {
    setTimeout(function () {
      var chat = $("#chat");
      chat.on("DOMSubtreeModified", function () {
        if (chat.html().length !== 0) { // Chat messages have loaded
          chat.off("DOMSubtreeModified");

          $(fire.SDMessageSelector).each(function () {
            decorateMessage(this);
          });

          fire.log("Decorated existing messages.");
        }
      });
    }, timeout);
  }

  // Gets a log wrapper for the specified console function.
  function getLogger(fn) {
    return function () {
      if (fire.debug)
      {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(fire.emoji.fire + " FIRE " + fn + ":");
        console[fn].apply(console, args);
      }
    };
  }

  // Handle socket messages
  function socketOnMessage(message) {
    var data = JSON.parse(message.data);

    switch (data.type) {
      case "confirm_subscription":
      case "ping":
      case "welcome":
        break;
      default: {
        var info = data.message;
        var url;

        if (info.flag_log) {            // Autoflagging information
          url = info.flag_log.post.link;
        } else if (info.deletion_log) { // Deletion log
          url = info.deletion_log.post_link;
        } else if (info.feedback) {     // Feedback
          url = info.feedback.post_link;
        } else if (info.not_flagged) {  // Not flagged
          url = info.not_flagged.post.link;
        } else {
          console.log("Socket message: ", info);
        }

        delete fire.reportCache[url]; // Remove this url from the cache, if it's in there.
        break;
      }
    }
  }

  // Expands anchor elements in the report's body on hover, to show the href.
  function expandLinksOnHover() {
    $(".fire-popup-body a")
      .each(function () {
        $(this).attr("fire-tooltip", this.href);
      });
  }

  // Initializes localStorage
  function initLocalStorage(hOP, defaultStorage) {
    registerForLocalStorage(fire, "userData", "fire-user-data");
    registerForLocalStorage(fire, "sites", "fire-sites");

    if (fire.userData === null) {
      fire.userData = defaultStorage;
    }
    var data = fire.userData;
    for (var key in defaultStorage) {
      if (hOP(defaultStorage, key) && !hOP(data, key)) {
        data[key] = defaultStorage[key];
      }
    }
    fire.userData = data;

    fire.log("Initialized localStorage.");
  }

  // Sets a value on `fire.userData`, stored in `localStorage`
  function setValue(key, value) {
    var data = fire.userData;
    data[key] = value;
    fire.userData = data;
  }

  // Removes a value from `fire.userData`, stored in `localStorage`
  function clearValue(key) {
    var data = fire.userData;
    delete data[key];
    fire.userData = data;
  }

  // Gets the currently logged-in user.
  function getCurrentUser() {
    setTimeout(function () { // This code was too fast for FireFox
      CHAT.RoomUsers
        .get(CHAT.CURRENT_USER_ID)
        .done(function (user) {
          fire.chatUser = user;

          fire.log("Current user found.");
        });
    });
  }
})();
