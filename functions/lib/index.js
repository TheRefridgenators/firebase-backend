const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {
  CloudTasksClient
} = require("@google-cloud/tasks");
const {
  Expo
} = require("expo-server-sdk");
const path = require("path");
const {
  ADDRGETNETWORKPARAMS
} = require("dns");

// import { DetectedItem, ItemLabel, TaskPayload } from "./types";

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

admin.initializeApp();
const expoInstance = new Expo();
const tasksClient = new CloudTasksClient();

const projectId = "foodtrack-4a83e";
const location = "us-central1";
const taskQueue = "foodtrack-notifications";
const queuePath = tasksClient.queuePath(projectId, location, taskQueue);

const sendUserNotificationsUrl = `https://${location}-${projectId}.cloudfunctions.net/sendUserNotifications`;

exports.onItemUpdate = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const userPushTokens = change.after.data().pushTokens || [];

    if (!userPushTokens.length) return;

    const previousItems = change.before.data().items;
    const previousItemData = previousItems.map((item) => ({
      label: item.label,
      filename: item.imagePath
    }));

    const currentItems = change.after.data().items;
    const currentLabels = currentItems.map((item) => item.label);

    // Schedule notifications for missing (multi-use) items
    await scheduleMissingItemNotifications(userPushTokens, context.params.userId, previousItemData, currentLabels);

    // Ask user to identify any items with the label "null"
    await alertOnNullLabel(userPushTokens, context.params.userId, currentItems, currentLabels, previousItems);
  });

exports.sendUserNotifications = functions.https.onRequest(
  async (req, res) => {
    const {
      pushTokens,
      docPath,
      userId,
    } = req.body;

    const notificationDocRef = await admin.firestore().doc(docPath).get();
    const items = notificationDocRef.data().missingItems;

    const itemNotifications = items.map(({
        label
      }) =>
      itemToPushMessage(label, pushTokens)
    );

    const notificationChunks = expoInstance.chunkPushNotifications(
      itemNotifications
    );

    // Send notifications via expo
    for (const chunk of notificationChunks) {
      try {
        await expoInstance.sendPushNotificationsAsync(chunk);
        console.log("Sent a notification")
      } catch (error) {
        console.error(error);
      }
    }

    // Write alerts to Firestore
    for (const {
        itemLabel,
        filename
      } of items) {
      const alertData = notificationDataToAlert(itemLabel, filename, new Date());

      await admin
        .firestore()
        .collection(`users/${userId}/alerts`)
        .doc()
        .set(alertData);
    }

    await admin.firestore().doc(docPath).delete();

    res.sendStatus(200);
  }
);

/*
exports.applyOverridesAndAlertNullLabel = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const prevLabels = change.before.get("items").map((item) => item.label);
    const userItems = change.after.get("items");
    const currentLabels = userItems.map((item) => item.label);

    //await applyOverrides(context.params.userId);

    if (
      prevLabels.reduce((acc, label) => acc && currentLabels.includes(label), true) &&
      prevLabels.length === currentLabels.length
    ) return;

    const identifyNotifications = [];

    for (let idx = 0; idx < userItems.length; idx++) {
      const currentItem = userItems[idx];

      if (currentItem.label == "null") {
        await admin
          .firestore()
          .doc(`users/${context.params.userId}`)
          .collection("alerts")
          .doc()
          .set({
            summary: "Can you identify this item?",
            itemData: currentItem,
            timestamp: new Date(),
            purpose: "ask",
          });

        const identifyNotification = {
          to: change.after.get("pushTokens"),
          sound: "default",
          badge: 1,
          title: "Unknown item detected",
          body: "I don't recognize an item that you put in your refrigerator. Can you tell me what it is?"
        };

        identifyNotifications.push(identifyNotification);
      }
    }

    if (identifyNotifications.length) {
      const notificationChunks = expoInstance.chunkPushNotifications(identifyNotifications);

      for (const chunk of notificationChunks) {
        await expoInstance.sendPushNotificationsAsync(chunk);
      }
    }
  });
  */

exports.addUserSnapshot = functions.storage
  .object()
  .onFinalize(async (image) => {
    const imagePath = image.name;

    if (!imagePath.startsWith("snapshots")) return;

    const splitPath = imagePath.split("/");
    const userUid = splitPath[1];
    const filename = splitPath[2];

    // Add snapshot to user's "snapshots" collection in Firestore
    await admin.firestore()
      .collection(`users/${userUid}/snapshots`)
      .doc()
      .set({
        filename,
        timestamp: new Date(),
      });
  });

async function applyOverrides(userUid) {
  const userDocSnapshot = await admin.firestore().doc(`users/${userUid}`).get();
  const userOverrides = await admin.firestore().collection(`users/${userUid}/overrides`).listDocuments();

  const alreadyOverriddenItems = userDocSnapshot.data().items.filter((item) => item.overridden);

  const overriddenItems = userDocSnapshot.data().items.filter((item) => !item.overridden).map((item) => {
    const itemConfidence = item.confidence;
    const itemArea = item.area;

    const matchingOverrides = userOverrides.filter(({
      area,
      confidence
    }) => {
      return inRangeInclusive(area - 1000, area + 1000, itemArea) && inRangeInclusive(confidence - 1000, confidence + 1000, itemConfidence);
    });

    if (matchingOverrides.length > 0) {
      const override = matchingOverrides[0];

      const overriddenItem = {
        ...item,
        label: override.label,
        useClass: override.useClass,
        overridden: true,
      }

      return overriddenItem;
    } else {
      return item;
    }
  });

  if (overriddenItems.length)
    admin.firestore().doc(`users/${userUid}`).update({
      items: overriddenItems.concat(alreadyOverriddenItems),
    });
}

function inRangeInclusive(bottom, top, value) {
  return bottom <= value && value <= top;
}

async function scheduleMissingItemNotifications(pushTokens, userId, previousItemData, currentLabels) {

  for (const label of currentLabels) {
    try {
      await cancelTaskIfItemPutBack(label, userId);
    } catch (error) {
      console.error(error);
    }
  }

  const missingItems = [];
  const sendTimeSeconds = Date.now() / 1000 + 30; /* 30 seconds from now; in practice should be 20 minutes */

  previousItemData.forEach((item) => {
    if (!currentLabels.includes(item.label) && item.useClass === "multi") {
      missingItems.push(item);
    }
  });

  if (missingItems.length === 0) return;

  const notificationDoc = await admin
    .firestore()
    .collection(`users/${userId}/notifications`)
    .doc();

  const payload = {
    pushTokens: pushTokens,
    docPath: notificationDoc.path,
    userId: userId,
  };

  // Required for type reasons; otherwise createTask errors out
  const httpMethod = "POST";

  const task = {
    httpRequest: {
      httpMethod,
      url: sendUserNotificationsUrl,
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      headers: {
        "Content-Type": "application/json",
      },
    },
    scheduleTime: {
      seconds: sendTimeSeconds,
    },
  };

  const [response] = await tasksClient.createTask({
    parent: queuePath,
    task,
  });

  await notificationDoc.set({
    missingItems,
    taskName: response.name,
  });
}

async function alertOnNullLabel(pushTokens, userId, currentItems, currentLabels, previousItems) {
  const previousLabels = previousItems.map((item) => item.label);

  // await applyOverrides(userId);

  if (
    previousLabels.reduce((acc, label) => acc && currentLabels.includes(label), true) &&
    previousLabels.length === currentLabels.length
  ) return;

  const identifyNotifications = [];

  for (const currentItem of currentItems) {
    if (currentItem.label == "null") {
      await admin
        .firestore()
        .doc(`users/${userId}`)
        .collection("alerts")
        .doc()
        .set({
          summary: "Can you identify this item?",
          itemData: currentItem,
          timestamp: new Date(),
          purpose: "ask",
        });

      const identifyNotification = {
        to: pushTokens,
        sound: "default",
        badge: 1,
        title: "Unknown item detected",
        body: "I don't recognize an item that you put in your refrigerator. Can you tell me what it is?"
      };

      identifyNotifications.push(identifyNotification);
    }
  }

  if (identifyNotifications.length) {
    const notificationChunks = expoInstance.chunkPushNotifications(identifyNotifications);

    for (const chunk of notificationChunks) {
      await expoInstance.sendPushNotificationsAsync(chunk);
    }
  }
}

async function cancelTaskIfItemPutBack(label, userId) {
  const notificationList = await admin.firestore().collection(`users/${userId}/notifications`).listDocuments();

  for (const notification of notificationList) {
    const docSnapshot = await notification.get();
    const {
      missingItems,
      taskName
    } = docSnapshot.data();

    console.log('missingItems :>> ', missingItems);

    if (missingItems && missingItems.includes(label)) {
      const newMissingItems = missingItems.filter(val => val !== label);

      if (newMissingItems.length === 0) {
        await tasksClient.deleteTask({
          name: taskName
        });

        await notification.delete();
      } else {
        await notification.update({
          missingItems: newMissingItems
        });
      }
    }
  }
}

function itemToPushMessage(
  label, pushTokens
) {
  return {
    to: pushTokens,
    sound: "default",
    badge: 1,
    title: "Item left out of fridge",
    body: `You left ${useProperArticle(
      label
    )} outside of the fridge for 20 minutes!`,
  };
}

function notificationDataToAlert(itemName, filename, timestamp) {
  return {
    summary: `You left your ${itemName} outside the fridge for 20 minutes!`,
    filename,
    timestamp,
    purpose: "notify",
  }
}

/*
function arraysHaveSameValues(array1, array2) {
  if (array1.length !== array2.length) return false;

  let areEqual = true;

  array1.forEach((element) => {
    if (!array2.includes(element)) {
      areEqual = false;
    }
  });

  array2.forEach((element) => {
    if (!array1.includes(element)) {
      areEqual = false;
    }
  });

  return areEqual;
}
*/

function useProperArticle(noun) {
  return (noun.match(/^aeiou/i) ? "an " : "a ") + noun;
}