import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface EmergencyPayload {
  call_id?: string;
  user_id?: string;
  caller_phone?: string;
  caller_name?: string;
  summary?: string;
  contact_phone?: string;
  address?: string;
  issue_description?: string;
}

function jsonResponse(
  data: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}


serve(async (req) => {

  const requestId = crypto.randomUUID();

  try {

    if (req.method !== "POST") {
      return jsonResponse(
        {
          success: false,
          error: "Method not allowed",
          requestId
        },
        405
      );
    }


    const payload =
      await req.json() as EmergencyPayload;


    console.log(
      JSON.stringify({
        event: "emergency_escalation_received",
        requestId,
        payload
      })
    );


    if (!payload.call_id) {

      return jsonResponse(
        {
          success:false,
          error:"Missing call_id",
          requestId
        },
        400
      );
    }



    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const serviceKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");


    if (!supabaseUrl || !serviceKey) {

      console.error(
        "Missing Supabase environment variables"
      );

      return jsonResponse(
        {
          success:false,
          error:"Server configuration error",
          requestId
        },
        500
      );
    }



    const supabase =
      createClient(
        supabaseUrl,
        serviceKey,
        {
          auth:{
            autoRefreshToken:false,
            persistSession:false
          }
        }
      );



    /*
      Update escalation tracking.
      This does NOT touch emergency logic.
      It only records that escalation process started.
    */

    const { error:updateError } =
      await supabase
        .from("calls")
        .update({
          escalated_at:
            new Date().toISOString(),

          escalated_to:
            payload.contact_phone ?? null
        })
        .eq(
          "id",
          payload.call_id
        );



    if(updateError){

      console.error(
        "Database update failed",
        updateError
      );

      return jsonResponse(
        {
          success:false,
          error:"Failed updating call escalation",
          requestId
        },
        500
      );
    }




    /*
      Future production integration:

      1. Twilio SMS
      2. Twilio Voice call
      3. Vapi outbound emergency call

      This section intentionally stays isolated
      so external providers cannot break
      emergency database workflow.
    */


    console.log(
      JSON.stringify({

        event:
          "emergency_ready_for_provider",

        requestId,

        technician:
          payload.contact_phone,

        customer:
          payload.caller_phone,

        issue:
          payload.issue_description ??
          payload.summary

      })
    );




    return jsonResponse({

      success:true,

      requestId,

      message:
        "Emergency escalation processed",

      escalation:{
        call_id:
          payload.call_id,

        technician:
          payload.contact_phone ?? null
      }

    });



  } catch(error){

    console.error(
      JSON.stringify({

        event:
          "emergency_function_error",

        requestId,

        error:
          error instanceof Error
            ? error.message
            : String(error)

      })
    );


    return jsonResponse(

      {
        success:false,

        error:
          "Internal server error",

        requestId

      },

      500

    );

  }

});
