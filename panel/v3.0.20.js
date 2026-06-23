const VERSION = '3.0.20';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ==========================================
        //              UI ROUTE
        // ==========================================
        if (url.pathname === '/') {
            return new Response(getHTMLPage(env.PANEL_NAME || 'پنل مدیریت هوشمند'), {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8'
                }
            });
        }

        // ==========================================
        //              CORS HEADERS
        // ==========================================
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers
            });
        }

        // ==========================================
        //              API ROUTES
        // ==========================================

        // --- Auth API ---
        if (url.pathname === '/api/login' && request.method === 'POST') return await handleLogin(request, env);
        if (url.pathname === '/api/admin-info') return await handleGetAdminInfo(request, env);
        if (url.pathname === '/api/admins-list') return await handleGetAdminsList(request, env);

        // --- Subscriptions API ---
        if (url.pathname === '/api/data') return await handleGetData(request, env);
        if (url.pathname === '/api/add' && request.method === 'POST') return await handleAddSubscription(request, env);
        if (url.pathname === '/api/update' && request.method === 'PUT') return await handleUpdateSubscription(request, env);
        if (url.pathname === '/api/delete' && request.method === 'DELETE') return await handleDeleteSubscription(request, env);
        if (url.pathname === '/api/bulk-update' && request.method === 'POST') return await handleBulkUpdate(request, env);

        // --- Pool API ---
        if (url.pathname === '/api/pool/available') return await handleGetAvailablePool(request, env);
        if (url.pathname === '/api/pool/all') return await handleGetAllPools(request, env);
        if (url.pathname === '/api/pool/add' && request.method === 'POST') return await handleAddToPool(request, env);
        if (url.pathname === '/api/pool/update' && request.method === 'PUT') return await handleUpdatePool(request, env);
        if (url.pathname === '/api/pool/delete' && request.method === 'DELETE') return await handleDeletePool(request, env);

        // --- Admin CRUD API ---
        if (url.pathname === '/api/admin/crud/list') return await handleAdminListFull(request, env);
        if (url.pathname === '/api/admin/crud/add' && request.method === 'POST') return await handleAdminAdd(request, env);
        if (url.pathname === '/api/admin/crud/update' && request.method === 'PUT') return await handleAdminUpdate(request, env);
        if (url.pathname === '/api/admin/crud/delete' && request.method === 'DELETE') return await handleAdminDelete(request, env);

        return new Response('Not Found', {
            status: 404
        });
    }
};

// ==========================================
//              BACKEND LOGIC
// ==========================================

async function handleLogin(request, env) {
    try {
        const body = await request.json();
        const {
            username,
            password
        } = body;

        if (!username || !password) {
            return jsonResponse({
                error: 'نام کاربری و رمز عبور الزامی است'
            }, 400);
        }

        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?username=eq.${encodeURIComponent(username)}&password=eq.${encodeURIComponent(password)}`, {
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`
            }
        });

        const adminData = await response.json();

        if (adminData.length === 0) {
            return jsonResponse({
                error: 'نام کاربری یا رمز عبور اشتباه است'
            }, 401);
        }

        const admin = adminData[0];
        const authToken = btoa(`${username}:${password}:${admin.id}`);

        return jsonResponse({
            success: true,
            authToken,
            admin: {
                id: admin.id,
                username: admin.username,
                role: admin.role,
                max_subs: admin.max_subs,
                default_config_name: admin.default_config_name,
                can_edit_config_name: admin.can_edit_config_name,
                price_1_mo: admin.price_1_mo || 0,
                price_2_mo: admin.price_2_mo || 0,
                price_3_mo: admin.price_3_mo || 0
            }
        });
    } catch (error) {
        return jsonResponse({
            error: 'خطا در اتصال به سرور'
        }, 500);
    }
}

async function handleGetData(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);

    const url = new URL(request.url);
    let query = 'select=*,pool(name,url,owner_id),admins(username)&order=created_at.desc';

    if (admin.role === 1) {
        const adminFilter = url.searchParams.get('admin_filter');
        const filterCreated = url.searchParams.get('filter_created');
        const filterEnded = url.searchParams.get('filter_ended');

        if (adminFilter) query += `&admin_id=eq.${adminFilter}`;
        if (filterCreated) query += `&created_at=gte.${filterCreated}`;
        if (filterEnded) query += `&ended_at=lte.${filterEnded}`;
    } else {
        query += `&admin_id=eq.${admin.id}`;
    }

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?${query}`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    return jsonResponse(await response.json());
}

async function handleBulkUpdate(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);

    const {
        ids,
        days,
        type
    } = await request.json();
    if (!ids || ids.length === 0) return jsonResponse({
        error: 'هیچ موردی انتخاب نشده'
    }, 400);

    const msToAdd = (type === 'add' ? 1 : -1) * (days * 24 * 60 * 60 * 1000);
    const idQuery = ids.join(',');

    const currentDataRes = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?id=in.(${idQuery})`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    const currentData = await currentDataRes.json();

    let updates = [];
    const now = new Date();

    currentData.forEach(sub => {
        const oldDate = new Date(sub.ended_at);
        const newDate = new Date(oldDate.getTime() + msToAdd);

        let status = sub.status;
        if (newDate < now) {
            status = false;
        } else {
            if (type === 'add') status = true;
        }

        updates.push({
            id: sub.id,
            ended_at: newDate.toISOString(),
            status: status
        });
    });

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
        method: 'POST',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(updates)
    });

    if (!response.ok) return jsonResponse({
        error: 'Bulk update failed'
    }, 500);
    return jsonResponse({
        success: true,
        count: updates.length
    });
}

async function handleAddSubscription(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);
    if (admin.role > 3) return jsonResponse({
        error: 'دسترسی ندارید'
    }, 403);

    const body = await request.json();
    const {
        username,
        pool_id,
        ended_at,
        status,
        admin_id,
        config_name,
        payment_status,
        settlement_status,
        note,
        total_volume,
        used_volume,
        price
    } = body;

    if (new Date(ended_at) < new Date()) return jsonResponse({
        error: 'تاریخ نامعتبر'
    }, 400);

    if (admin.role !== 1) {
        const countRes = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?admin_id=eq.${admin.id}&status=eq.true&select=id`, {
            method: 'HEAD',
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`,
                'Prefer': 'count=exact'
            }
        });
        const range = countRes.headers.get('content-range');
        const currentCount = range ? parseInt(range.split('/')[1] || 0) : 0;
        const limit = admin.max_subs !== undefined ? admin.max_subs : 9999;
        if (currentCount >= limit) return jsonResponse({
            error: 'سقف مجاز پر شد'
        }, 403);
    }

    try {
        const targetAdminId = (admin.role === 1 && admin_id) ? parseInt(admin_id) : admin.id;
        let finalConfigName = config_name || admin.default_config_name || '@TutiVpn';

        const newSubscription = {
            username,
            pool_id: parseInt(pool_id),
            admin_id: targetAdminId,
            ended_at,
            status: status !== undefined ? status : true,
            config_name: finalConfigName,
            payment_status: payment_status || 'paid',
            settlement_status: (admin.role === 1 && settlement_status) ? settlement_status : 'unsettled',
            note: note || '',
            total_volume: total_volume ? parseFloat(total_volume) : 0,
            used_volume: used_volume ? parseFloat(used_volume) : 0,
            price: price ? parseInt(price) : 0
        };

        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(newSubscription)
        });
        if (!response.ok) return jsonResponse({
            error: 'خطا'
        }, 400);
        return jsonResponse(await response.json());
    } catch (error) {
        return jsonResponse({
            error: 'Error'
        }, 500);
    }
}

async function handleUpdateSubscription(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);
    if (admin.role > 3) return jsonResponse({
        error: 'دسترسی ندارید'
    }, 403);

    try {
        const body = await request.json();
        const {
            id,
            username,
            ended_at,
            status,
            admin_id,
            config_name,
            payment_status,
            settlement_status,
            note,
            total_volume,
            used_volume,
            price
        } = body;

        if (ended_at && new Date(ended_at) < new Date() && status !== false) return jsonResponse({
            error: 'تاریخ نامعتبر'
        }, 400);

        let url = `${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${id}`;
        if (admin.role !== 1) url += `&admin_id=eq.${admin.id}`;

        const updatePayload = {
            username,
            ended_at,
            status
        };
        if (payment_status) updatePayload.payment_status = payment_status;
        if (config_name && (admin.role === 1 || admin.can_edit_config_name)) updatePayload.config_name = config_name;
        if (config_name && !admin.can_edit_config_name && admin.role !== 1) {
             updatePayload.config_name = config_name;
        }

        if (note !== undefined) updatePayload.note = note;
        if (total_volume !== undefined) updatePayload.total_volume = parseFloat(total_volume);
        if (used_volume !== undefined) updatePayload.used_volume = parseFloat(used_volume);
        if (price !== undefined && admin.role === 1) updatePayload.price = parseInt(price);

        if (admin.role === 1) {
            if (admin_id) updatePayload.admin_id = parseInt(admin_id);
            if (settlement_status) updatePayload.settlement_status = settlement_status;
        }

        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
        });
        if (!response.ok) return jsonResponse({
            error: 'خطا'
        }, 400);
        return jsonResponse({
            success: true
        });
    } catch (error) {
        return jsonResponse({
            error: 'Error'
        }, 500);
    }
}

async function handleDeleteSubscription(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);
    if (admin.role !== 1) return jsonResponse({
        error: 'دسترسی ندارید'
    }, 403);
    const id = new URL(request.url).searchParams.get('id');
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}

// Pool Handlers
async function handleGetAvailablePool(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/available_pool_items?order=created_at.desc`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    let data = await response.json();

    if (data.length > 0) {
        data = data.filter(item => item.is_active !== false);

        if (admin.role !== 1) {
            data = data.filter(item => {
                return (item.owner_id == null) || (String(item.owner_id) === String(admin.id));
            });
        }
    }
    return jsonResponse(data);
}

async function handleGetAllPools(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role > 2) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/pool?order=created_at.desc`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    let data = await response.json();
    
    if (admin.role === 2) {
        data = data.filter(item => (item.owner_id == null) || (String(item.owner_id) === String(admin.id)));
    }
    return jsonResponse(data);
}

async function handleAddToPool(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role > 2) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const {
        name,
        url,
        note,
        owner_id,
        is_active
    } = await request.json();
    
    const checkRes = await fetch(`${env.SUPABASE_URL}/rest/v1/pool?name=eq.${encodeURIComponent(name)}`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    if ((await checkRes.json()).length > 0) return jsonResponse({
        error: 'تکراری'
    }, 400);
    
    const payload = {
        name,
        url,
        note: note || '',
        is_active: is_active !== undefined ? is_active : true
    };
    
    if (admin.role === 1) payload.owner_id = owner_id ? parseInt(owner_id) : null;
    else payload.owner_id = admin.id;
    
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/pool`, {
        method: 'POST',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}

async function handleUpdatePool(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role > 2) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const {
        id,
        name,
        url,
        note,
        owner_id,
        is_active
    } = await request.json();
    
    if (admin.role === 2) {
        const poolRes = await fetch(`${env.SUPABASE_URL}/rest/v1/pool?id=eq.${id}`, {
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`
            }
        });
        const pool = (await poolRes.json())[0];
        if (pool.owner_id !== admin.id && pool.owner_id !== null) return jsonResponse({
            error: 'دسترسی ندارید'
        }, 403);
    }
    
    const payload = {
        name,
        url,
        note
    };
    
    if (is_active !== undefined) payload.is_active = is_active;
    
    if (admin.role === 1 && owner_id !== undefined) payload.owner_id = owner_id ? parseInt(owner_id) : null;
    
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/pool?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}

async function handleDeletePool(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const id = new URL(request.url).searchParams.get('id');
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/pool?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}

// Admin CRUD
async function handleAdminListFull(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?order=created_at.desc`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    return jsonResponse(await response.json());
}
async function handleAdminAdd(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const {
        username,
        password,
        role,
        max_subs,
        default_config_name,
        can_edit_config_name,
        price_1_mo,
        price_2_mo,
        price_3_mo
    } = await request.json();
    const payload = {
        username,
        password,
        role: parseInt(role),
        max_subs: parseInt(max_subs),
        default_config_name: default_config_name || '@TutiVpn',
        can_edit_config_name: can_edit_config_name || false,
        price_1_mo: price_1_mo ? parseInt(price_1_mo) : 0,
        price_2_mo: price_2_mo ? parseInt(price_2_mo) : 0,
        price_3_mo: price_3_mo ? parseInt(price_3_mo) : 0
    };
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins`, {
        method: 'POST',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}
async function handleAdminUpdate(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const {
        id,
        username,
        password,
        role,
        max_subs,
        default_config_name,
        can_edit_config_name,
        price_1_mo,
        price_2_mo,
        price_3_mo
    } = await request.json();
    const payload = {
        username,
        role: parseInt(role),
        max_subs: parseInt(max_subs),
        default_config_name,
        can_edit_config_name,
        price_1_mo: price_1_mo ? parseInt(price_1_mo) : 0,
        price_2_mo: price_2_mo ? parseInt(price_2_mo) : 0,
        price_3_mo: price_3_mo ? parseInt(price_3_mo) : 0
    };
    if (password) payload.password = password;
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) return jsonResponse({
        error: 'خطا'
    }, 400);
    return jsonResponse({
        success: true
    });
}
async function handleAdminDelete(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const targetId = new URL(request.url).searchParams.get('id');
    if (targetId == admin.id) return jsonResponse({
        error: 'خطا'
    }, 400);
    const now = new Date().toISOString();
    const checkActive = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?admin_id=eq.${targetId}&status=eq.true&ended_at=gt.${now}`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    if ((await checkActive.json()).length > 0) return jsonResponse({
        error: 'اشتراک فعال دارد'
    }, 400);
    await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?admin_id=eq.${targetId}`, {
        method: 'PATCH',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            admin_id: admin.id
        })
    });
    const delRes = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?id=eq.${targetId}`, {
        method: 'DELETE',
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    if (!delRes.ok) return jsonResponse({
        error: 'خطا'
    }, 500);
    return jsonResponse({
        success: true
    });
}

async function handleGetAdminInfo(request, env) {
    const admin = await authenticate(request, env);
    if (!admin) return jsonResponse({
        error: 'Unauthorized'
    }, 401);
    return jsonResponse(admin);
}
async function handleGetAdminsList(request, env) {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== 1) return jsonResponse({
        error: 'Access Denied'
    }, 403);
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?select=id,username`, {
        headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`
        }
    });
    return jsonResponse(await response.json());
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}
async function authenticate(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return null;
    try {
        const token = authHeader.replace('Bearer ', '');
        const decoded = atob(token);
        const parts = decoded.split(':');
        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/admins?username=eq.${encodeURIComponent(parts[0])}&password=eq.${encodeURIComponent(parts[1])}`, {
            headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`
            }
        });
        const adminData = await response.json();
        return adminData.length > 0 ? adminData[0] : null;
    } catch (e) {
        return null;
    }
}

// ==========================================
//              FRONTEND (HTML/JS)
// ==========================================

function getHTMLPage(panelName) {
    return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${panelName} - ${VERSION}</title>
  <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
  <style>
    :root { --bg-color:#0f172a; --card-bg:#1e293b; --primary:#3b82f6; --text:#f1f5f9; --subtext:#94a3b8; --border:#334155; }
    *{margin:0;padding:0;box-sizing:border-box;outline:none;}
    body{font-family:'Vazirmatn',sans-serif;background:var(--bg-color);color:var(--text);padding-top:80px;padding-bottom:70px;display:block;}
    .top-bar{position:fixed;top:0;left:0;right:0;height:64px;background:rgba(15,23,42,0.95);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;z-index:1000;}
    .logo-text{font-weight:700;font-size:16px;color:var(--primary);}
    .tabs{display:flex;gap:4px;background:rgba(255,255,255,0.05);padding:3px;border-radius:8px;margin-right:16px;}
    .tab-btn{background:transparent;color:var(--subtext);border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;}
    .tab-btn.active{background:var(--primary);color:white;}
    .card{background:var(--card-bg);border:1px solid var(--border);border-radius:12px;width:92%;max-width:1300px;margin:0 auto 24px auto;display:none;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);}
    .card.active{display:block;animation:fadeIn 0.3s ease;}
    .card-header{padding:16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
    .card-header h3{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}
    .card-content{padding:16px;}
    .button{padding:8px 14px;border-radius:8px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-family:inherit;font-size:13px;transition:0.2s;}
    .btn-primary{background:var(--primary);color:white;}
    .btn-success{background:#10b981;color:white;}
    .btn-icon{background:rgba(255,255,255,0.05);color:var(--subtext);padding:6px;border-radius:6px;}
    .table-responsive{width:100%;overflow-x:auto;border-radius:8px;border:1px solid var(--border);}
    table{width:100%;border-collapse:collapse;min-width:900px;}
    th,td{padding:12px;text-align:right;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap;}
    th{background:rgba(0,0,0,0.2);color:var(--subtext);font-weight:500;}
    td{color:var(--text);}
    .status-badge{padding:3px 8px;border-radius:12px;font-size:11px;}
    .active{background:rgba(16,185,129,0.2);color:#34d399;}
    .inactive{background:rgba(148,163,184,0.2);color:#94a3b8;}
    .expired{background:rgba(239,68,68,0.2);color:#f87171;}
    .filter-group{display:flex;gap:8px;margin-bottom:16px;overflow-x:auto;padding-bottom:4px;}
    .filter-btn{background:transparent;border:1px solid var(--border);color:var(--subtext);padding:6px 14px;border-radius:20px;font-size:12px;cursor:pointer;white-space:nowrap;}
    .filter-btn.active{background:var(--text);color:var(--bg-color);font-weight:600;}
    .text-field{margin-bottom:14px;display:flex;flex-direction:column;gap:6px;}
    .text-field label{font-size:12px;color:var(--subtext);}
    .text-field-input{padding:10px;background:rgba(0,0,0,0.3);border:1px solid var(--border);color:white;border-radius:8px;width:100%;font-family:inherit;}
    .dialog-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:2000;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);}
    .dialog-overlay.active{display:flex;}
    .dialog{background:var(--card-bg);width:90%;max-width:550px;padding:24px;border-radius:16px;border:1px solid var(--border);max-height:90vh;overflow-y:auto;}
    .toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#334155;color:white;padding:10px 20px;border-radius:30px;z-index:3000;font-size:13px;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);}
    .toast.show{display:block;animation:fadeInUp 0.3s;}
    .login-box{max-width:360px;margin-top:60px;}
    .advanced-search{background:rgba(0,0,0,0.2);padding:16px;border-radius:12px;margin-bottom:16px;display:none;}
    .search-row{display:flex;gap:10px;flex-wrap:wrap;}
    .col{flex:1;min-width:140px;}
    .bottom-nav{position:fixed;bottom:0;left:0;right:0;height:60px;background:#1e293b;border-top:1px solid var(--border);display:none;justify-content:space-around;align-items:center;z-index:900;}
    .nav-item{color:var(--subtext);display:flex;flex-direction:column;align-items:center;font-size:10px;gap:4px;padding:8px;cursor:pointer;}
    .nav-item.active{color:var(--primary);}
    .nav-item span{font-size:22px;}
    textarea.text-field-input{min-height:80px;resize:vertical;}
    
    /* New Tooltip CSS */
    .info-icon { cursor: pointer; color: var(--primary); vertical-align: middle; font-size: 16px; }
    .tooltip-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }
    .tooltip-wrap .tooltip-text { visibility: hidden; width: 200px; background-color: #334155; color: #fff; text-align: center; border-radius: 6px; padding: 8px; position: absolute; z-index: 10; bottom: 125%; left: 50%; transform: translateX(-50%); opacity: 0; transition: opacity 0.2s; font-size: 12px; pointer-events: none; box-shadow: 0 4px 10px rgba(0,0,0,0.5); white-space: normal; line-height: 1.4; border: 1px solid var(--border); }
    .tooltip-wrap:hover .tooltip-text { visibility: visible; opacity: 1; }
    
    /* Copy Dialog Specific */
    #copyDialog .dialog { max-width: 350px; }
    .copy-list { display: flex; flex-direction: column; gap: 12px; }
    .copy-item { display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
    .copy-label { font-size: 13px; color: var(--text); }

    /* Stats Cards */
    .stats-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: rgba(255,255,255,0.05); padding: 16px; border-radius: 12px; border: 1px solid var(--border); text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--primary); margin: 8px 0; }
    .stat-label { font-size: 13px; color: var(--subtext); }

    @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
    @keyframes fadeInUp{from{opacity:0;transform:translate(-50%,20px);}to{opacity:1;transform:translate(-50%,0);}}
    @media(max-width:768px){body{padding-top:70px;}.top-bar{padding:0 12px;}.logo-text{font-size:14px;}.tabs{display:none;}.bottom-nav{display:flex;}}
  </style>
</head>
<body>

  <div class="top-bar" id="topBar" style="display: none;">
    <div style="display:flex;align-items:center;">
        <div class="logo-text">${panelName}</div>
        <div class="tabs" style="margin-right:20px;">
            <button class="tab-btn active" onclick="switchTab('subs')" id="deskTabSubs">اشتراک‌ها</button>
            <button class="tab-btn" onclick="switchTab('pool')" id="deskTabPool" style="display:none;">سرورها</button>
            <button class="tab-btn" onclick="switchTab('admins')" id="deskTabAdmins" style="display:none;">همکاران</button>
            <button class="tab-btn" onclick="switchTab('stats')" id="deskTabStats" style="display:none;">آمار</button>
        </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;">
        <div id="statsBox" style="font-size:11px;background:#334155;padding:4px 8px;border-radius:4px;display:none;"></div>
        <span id="adminName" style="font-size:12px;color:var(--subtext);"></span>
        <button onclick="logout()" class="button" style="background:rgba(255,255,255,0.05);color:#f87171;padding:6px 10px;font-size:12px;">خروج</button>
        <button id="btnBulk" onclick="openBulkDialog()" class="button btn-primary" style="display:none;padding:6px 10px;font-size:12px;">عملیات</button>
    </div>
  </div>

  <div class="bottom-nav" id="bottomNav">
      <div class="nav-item active" onclick="switchTab('subs')" id="mobTabSubs"><span class="material-icons">people</span>اشتراک</div>
      <div class="nav-item" onclick="switchTab('pool')" id="mobTabPool" style="display:none;"><span class="material-icons">dns</span>سرور</div>
      <div class="nav-item" onclick="switchTab('admins')" id="mobTabAdmins" style="display:none;"><span class="material-icons">manage_accounts</span>همکاران</div>
      <div class="nav-item" onclick="switchTab('stats')" id="mobTabStats" style="display:none;"><span class="material-icons">bar_chart</span>آمار</div>
  </div>

  <div id="loginSection" class="card" style="max-width:360px;margin-top:60px;display:block;">
    <div class="card-header"><h3>ورود</h3></div>
    <div class="card-content">
      <div class="text-field"><label>نام کاربری</label><input type="text" id="loginUser" class="text-field-input"></div>
      <div class="text-field"><label>رمز عبور</label><input type="password" id="loginPass" class="text-field-input"></div>
      <button onclick="login()" class="button btn-primary" style="width:100%;justify-content:center;margin-top:10px;">ورود</button>
    </div>
  </div>

  <div id="subsCard" class="card">
      <div class="card-header"><h3>اشتراک‌ها</h3><button id="btnAddSub" onclick="openSubDialog('add')" class="button btn-primary" style="font-size:12px;"><span class="material-icons" style="font-size:16px;">add</span> جدید</button></div>
      <div class="card-content">
        <div class="filter-group">
            <button class="filter-btn active" onclick="setSubFilter('active')" id="filterActive">فعال</button>
            <button class="filter-btn" onclick="setSubFilter('expired')" id="filterExpired">منقضی</button>
        </div>
        <input type="text" id="simpleSearch" placeholder="جستجو..." class="text-field-input" style="margin-bottom:16px;" oninput="filterTable()">
        <div id="advSearchBox" style="background:rgba(0,0,0,0.2);padding:16px;border-radius:12px;margin-bottom:16px;display:none;">
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <div style="flex:1;"><label style="font-size:11px;color:#94a3b8;">نماینده</label><select id="searchAdminId" class="text-field-input"><option value="">همه</option></select></div>
                <div style="flex:1;"><label style="font-size:11px;color:#94a3b8;">شروع از</label><input type="date" id="searchCreated" class="text-field-input"></div>
                <div style="flex:1;"><label style="font-size:11px;color:#94a3b8;">پایان تا</label><input type="date" id="searchEnded" class="text-field-input"></div>
                <div style="flex:0;padding-top:20px;"><button onclick="loadData()" class="button btn-primary">اعمال</button></div>
            </div>
        </div>
        <div class="table-responsive">
            <table id="table">
                <thead>
                    <tr>
                        <th id="colCheck" style="display:none;"><input type="checkbox" onclick="toggleAllChecks(this)"></th>
                        <th>عملیات</th><th>نام کاربری</th><th>نام سرور</th><th>تاریخ ایجاد</th><th id="thIssuer" style="display:none;">صادرکننده</th><th>یادداشت</th><th>نام کانفیگ</th><th>تاریخ پایان اشتراک</th><th>قیمت (تومان)</th><th>وضعیت اشتراک</th><th>وضعیت پرداخت</th><th>وضعیت تسویه</th>
                    </tr>
                </thead>
                <tbody id="tbody"></tbody>
            </table>
        </div>
      </div>
  </div>

  <div id="poolCard" class="card">
      <div class="card-header"><h3>سرورها</h3><button onclick="openPoolDialog('add')" class="button btn-success" style="font-size:12px;"><span class="material-icons" style="font-size:16px;">add</span> جدید</button></div>
      <div class="card-content">
        <div class="table-responsive"><table id="poolTable"><thead><tr><th>شناسه</th><th>نام سرور</th><th>آدرس</th><th>یادداشت</th><th>تاریخ ایجاد</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody id="poolTbody"></tbody></table></div>
      </div>
  </div>

  <div id="adminsCard" class="card">
      <div class="card-header"><h3>همکاران</h3><button onclick="openAdminDialog('add')" class="button btn-primary" style="font-size:12px;"><span class="material-icons" style="font-size:16px;">add</span> جدید</button></div>
      <div class="card-content">
        <div class="table-responsive"><table id="adminTable"><thead><tr><th>نام</th><th>نقش</th><th>سقف</th><th>کانفیگ پیش‌فرض</th><th>ویرایش نام</th><th>قیمت ۱ ماهه</th><th>قیمت ۲ ماهه</th><th>قیمت ۳ ماهه</th><th>عملیات</th></tr></thead><tbody id="adminTbody"></tbody></table></div>
      </div>
  </div>
  
  <!-- Stats Tab Content -->
  <div id="statsCard" class="card">
      <div class="card-header"><h3>آمار و گزارشات</h3></div>
      <div class="card-content">
          <div class="stats-container">
              <div class="stat-card">
                  <div class="stat-label">اشتراک‌های فعال</div>
                  <div class="stat-value" id="statActiveSubs" style="color:#34d399;">0</div>
              </div>
              <div class="stat-card">
                  <div class="stat-label">تسویه نشده (تومان)</div>
                  <div class="stat-value" id="statUnsettledPrice" style="color:#f87171;">0</div>
              </div>
          </div>
          
          <div id="adminPerformanceSection" style="display:none;">
              <h4 style="margin:20px 0 10px 0;font-size:14px;">عملکرد نمایندگان</h4>
              <div class="table-responsive">
                  <table id="statsTable">
                      <thead><tr><th>نام نماینده</th><th>تعداد فعال</th><th>بدهی (تومان)</th></tr></thead>
                      <tbody id="statsTbody"></tbody>
                  </table>
              </div>
          </div>
      </div>
  </div>

  <div id="bulkDialog" class="dialog-overlay">
    <div class="dialog">
      <h3 style="margin-bottom:20px;">عملیات گروهی</h3>
      <div class="text-field"><label>انتخاب اشتراک‌ها</label><select id="bulkScope" class="text-field-input" onchange="toggleBulkSelect()"><option value="selected">موارد تیک خورده</option><option value="all">همه اشتراک‌های فعال</option></select></div>
      <div class="text-field"><label>نوع عملیات</label><select id="bulkActionType" class="text-field-input"><option value="add">افزایش زمان</option><option value="subtract">کاهش زمان</option></select></div>
      <div class="text-field"><label>تعداد روز</label><input type="number" id="bulkDays" class="text-field-input" value="30"></div>
      <div style="display:flex;gap:10px;margin-top:20px;"><button onclick="submitBulk()" class="button btn-primary" style="flex:1;justify-content:center;">اجرا</button><button onclick="closeDialog('bulkDialog')" class="button" style="border:1px solid var(--border);">لغو</button></div>
    </div>
  </div>

  <!-- Copy Dialog (New Design) -->
  <div id="copyDialog" class="dialog-overlay">
    <div class="dialog">
      <h3 style="margin-bottom:20px;">کپی لینک</h3>
      <div class="copy-list">
          <div class="copy-item">
              <div class="copy-label">لینک اصلی</div>
              <button onclick="copyMain()" class="button btn-primary" style="font-size:12px;">کپی</button>
          </div>
          <div class="copy-item">
              <div class="copy-label">لینک v2ray - hiddify</div>
              <button onclick="copySub()" class="button btn-primary" style="font-size:12px;">کپی</button>
          </div>
          <div class="copy-item">
              <div class="copy-label">لینک clash</div>
              <button onclick="copyClash()" class="button btn-primary" style="font-size:12px;">کپی</button>
          </div>
      </div>
      <div style="margin-top:20px;text-align:left;"><button onclick="closeDialog('copyDialog')" class="button" style="border:1px solid var(--border);">بستن</button></div>
    </div>
  </div>

  <div id="subDialog" class="dialog-overlay">
    <div class="dialog" style="max-width:500px;">
      <h3 id="subDialogTitle" style="margin-bottom:20px;"></h3><input type="hidden" id="subId">
      
      <div class="text-field"><label>نام کاربری</label><div style="display:flex;gap:8px;"><input type="text" id="subUser" class="text-field-input" style="flex:1;"><button onclick="randomUser()" class="button btn-icon">🎲</button></div></div>
      <div class="text-field" id="poolSelectDiv"><label>سرور</label><select id="subPoolId" class="text-field-input"><option>صبر کنید...</option></select></div>
      <div class="text-field" id="poolNameDiv" style="display:none;"><label>سرور</label><input type="text" id="subPoolName" class="text-field-input" disabled></div>
      <div class="text-field" id="assignAdminDiv" style="display:none;"><label>مالک</label><select id="assignAdminId" class="text-field-input"><option value="">خودم</option></select></div>
      
      <div class="text-field">
          <label>نام کانفیگ</label>
          <div id="configTypeRadios" style="display:none; gap:12px; margin-bottom:8px; font-size:12px;">
             <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                 <input type="radio" name="confType" value="default" onchange="updateConfigNameBasedOnSelection()"> نام پیش‌فرض
             </label>
             <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                 <input type="radio" name="confType" value="date" onchange="updateConfigNameBasedOnSelection()"> تاریخ پایان
             </label>
          </div>
          <div style="display:flex;gap:8px;"><input type="text" id="subConfigName" class="text-field-input" style="flex:1;"><button onclick="setConfDate()" id="btnConfDate" class="button btn-icon">📅</button></div>
      </div>

      <div class="text-field"><label>انقضا</label><input type="datetime-local" id="subEnd" class="text-field-input">
        <div style="display:flex;gap:6px;margin-top:6px;">
            <button onclick="addTime(1)" class="button btn-icon" style="flex:1;justify-content:center;font-size:11px;">1 ماه</button>
            <button onclick="addTime(2)" class="button btn-icon" style="flex:1;justify-content:center;font-size:11px;">2 ماه</button>
            <button onclick="addTime(3)" class="button btn-icon" style="flex:1;justify-content:center;font-size:11px;">3 ماه</button>
        </div>
      </div>
      
      <div class="text-field">
          <label>قیمت (تومان)</label>
          <input type="number" id="subPrice" class="text-field-input" disabled>
      </div>
      
      <div style="display:flex;gap:10px;">
          <div class="text-field" style="flex:1;"><label>وضعیت</label><select id="subStatus" class="text-field-input"><option value="true">فعال</option><option value="false">غیرفعال</option></select></div>
          <div class="text-field" style="flex:1;"><label>پرداخت مشتری</label><select id="subPayStatus" class="text-field-input"><option value="paid">پرداخت شده</option><option value="unpaid">پرداخت نشده</option><option value="pending">معلق</option></select></div>
      </div>
      
      <!-- Moved Note Field Here for All Roles -->
      <div class="text-field" style="margin-top: 10px;">
          <label>یادداشت</label>
          <textarea id="subNote" class="text-field-input" rows="2"></textarea>
      </div>
      
      <div id="role1Fields" style="display:none;border-top:1px solid var(--border);padding-top:10px;margin-top:10px;">
          <div class="text-field"><label>وضعیت تسویه</label><select id="subSetStatus" class="text-field-input"><option value="unsettled">تسویه نشده</option><option value="settled">تسویه شده</option></select></div>
      </div>

      <div style="display:flex;gap:10px;margin-top:20px;"><button onclick="saveSub()" class="button btn-primary" id="saveSubBtn" style="flex:1;justify-content:center;">ذخیره</button><button onclick="closeDialog('subDialog')" class="button" style="border:1px solid var(--border);">لغو</button></div>
    </div>
  </div>

  <div id="poolDialog" class="dialog-overlay">
    <div class="dialog">
      <h3 id="poolDialogTitle" style="margin-bottom:20px;"></h3><input type="hidden" id="poolId">
      <div class="text-field"><label>نام سرور</label><input type="text" id="poolNameInput" class="text-field-input"></div>
      <div class="text-field"><label>آدرس URL</label><textarea id="poolUrlInput" class="text-field-input" rows="4"></textarea></div>
      <div class="text-field"><label>یادداشت</label><textarea id="poolNoteInput" class="text-field-input" rows="2"></textarea></div>
      <div class="text-field" id="poolOwnerDiv" style="display:none;"><label>مالکیت</label><select id="poolOwnerInput" class="text-field-input"><option value="">عمومی</option></select></div>
      
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;" id="poolActiveDiv">
          <input type="checkbox" id="poolActiveInput" checked>
          <label for="poolActiveInput" style="margin:0;font-size:13px;">وضعیت سرور (فعال)</label>
      </div>

      <div style="display:flex;gap:10px;margin-top:20px;"><button onclick="savePool()" class="button btn-success" id="savePoolBtn" style="flex:1;justify-content:center;">ذخیره</button><button onclick="closeDialog('poolDialog')" class="button" style="border:1px solid var(--border);">لغو</button></div>
    </div>
  </div>

  <div id="adminDialog" class="dialog-overlay">
    <div class="dialog">
      <h3 id="adminDialogTitle" style="margin-bottom:20px;"></h3><input type="hidden" id="adminId">
      <div class="text-field"><label>نام کاربری</label><input type="text" id="adminUserInput" class="text-field-input"></div>
      <div class="text-field"><label>رمز عبور</label><input type="text" id="adminPassInput" class="text-field-input" placeholder="خالی = بدون تغییر"></div>
      <div class="text-field"><label>نقش</label><select id="adminRoleInput" class="text-field-input"><option value="1">مدیر کل</option><option value="2">نماینده ارشد</option><option value="3">نماینده عادی</option><option value="4">ناظر</option></select></div>
      <div class="text-field"><label>سقف اشتراک</label><input type="number" id="adminMaxInput" class="text-field-input" value="50"></div>
      
      <div style="border-top:1px solid var(--border); padding-top:10px; margin-top:10px; display:flex; gap:10px;">
          <div style="flex:1" class="text-field"><label>قیمت ۱ ماهه</label><input type="number" id="adminPrice1" class="text-field-input" value="0"></div>
          <div style="flex:1" class="text-field"><label>قیمت ۲ ماهه</label><input type="number" id="adminPrice2" class="text-field-input" value="0"></div>
          <div style="flex:1" class="text-field"><label>قیمت ۳ ماهه</label><input type="number" id="adminPrice3" class="text-field-input" value="0"></div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px;">
          <div class="text-field"><label>نام کانفیگ پیش‌فرض</label><input type="text" id="adminDefConfInput" class="text-field-input" value="@TutiVpn"></div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:10px;"><input type="checkbox" id="adminCanEditConfInput"><label for="adminCanEditConfInput" style="margin:0;font-size:13px;">اجازه تغییر نام</label></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px;"><button onclick="saveAdmin()" class="button btn-primary" id="saveAdminBtn" style="flex:1;justify-content:center;">ذخیره</button><button onclick="closeDialog('adminDialog')" class="button" style="border:1px solid var(--border);">لغو</button></div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let currentAdmin = null;
    let tableData = [];
    let poolData = [];
    let adminsData = [];
    let dialogMode = 'add';
    let poolDialogMode = 'add';
    let adminDialogMode = 'add';
    let subFilter = 'active';
    let isNameSynced = false;
    let currentCopyBase = '';

    if (localStorage.getItem('token')) {
        checkAuth();
    } else {
        document.getElementById('loginSection').style.display = 'block';
    }

    async function checkAuth() {
        try {
            const res = await api('/api/admin-info');
            if (res) {
                currentAdmin = res;
                let roleName = 'ناشناس';
                if (res.role === 1) roleName = 'مدیر کل';
                else if (res.role === 2) roleName = 'نماینده ارشد';
                else if (res.role === 3) roleName = 'نماینده عادی';
                else if (res.role === 4) roleName = 'ناظر';
                document.getElementById('adminName').innerText = res.username + ' (' + roleName + ')';
                
                if (res.role > 3) {
                    document.getElementById('btnAddSub').style.display = 'none';
                }
                
                if (res.role <= 2) {
                    document.getElementById('deskTabPool').style.display = 'block';
                    document.getElementById('mobTabPool').style.display = 'flex';
                }

                if (res.role === 1) {
                    document.getElementById('deskTabAdmins').style.display = 'block';
                    document.getElementById('mobTabAdmins').style.display = 'flex';
                    
                    document.getElementById('advSearchBox').style.display = 'block';
                    document.getElementById('simpleSearch').style.display = 'none';
                    document.getElementById('colCheck').style.display = 'table-cell';
                    document.getElementById('btnBulk').style.display = 'block';
                    
                    // Show Issuer Column Header for Role 1
                    document.getElementById('thIssuer').style.display = 'table-cell';
                    
                    loadAdminFilterList();
                } else {
                    document.getElementById('simpleSearch').style.display = 'block';
                }
                
                // Show Stats Tab for Everyone
                document.getElementById('deskTabStats').style.display = 'block';
                document.getElementById('mobTabStats').style.display = 'flex';

                document.getElementById('loginSection').style.display = 'none';
                document.getElementById('topBar').style.display = 'flex';
                document.getElementById('bottomNav').style.display = 'flex';
                
                document.getElementById('subEnd').addEventListener('change', function() {
                    const radios = document.getElementsByName('confType');
                    const isDateSelected = radios.length > 0 && radios[1].checked;
                    
                    if ((currentAdmin.role === 1 || currentAdmin.can_edit_config_name) && isNameSynced) {
                        setConfDate();
                    } else if (!currentAdmin.can_edit_config_name && isDateSelected) {
                        setConfDate();
                    }
                });

                switchTab('subs');
            } else {
                logout();
            }
        } catch (e) {
            logout();
        }
    }

    async function login() {
        const u = document.getElementById('loginUser').value;
        const p = document.getElementById('loginPass').value;
        const btn = document.querySelector('#loginSection .btn-primary');
        
        btn.innerText = '...'; 
        btn.disabled = true;
        
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                body: JSON.stringify({ username: u, password: p }),
                headers: { 'Content-Type': 'application/json' }
            });
            const d = await res.json();
            
            if (res.ok) {
                localStorage.setItem('token', d.authToken);
                checkAuth();
            } else {
                toast(d.error);
            }
        } catch (e) {
            toast('خطا');
        }
        btn.innerText = 'ورود'; 
        btn.disabled = false;
    }

    function logout() {
        localStorage.removeItem('token');
        location.reload();
    }
    
    function switchTab(t) {
        document.querySelectorAll('.card').forEach(function(c) { c.classList.remove('active'); });
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.nav-item').forEach(function(b) { b.classList.remove('active'); });
        
        if (t === 'subs') {
            document.getElementById('subsCard').classList.add('active');
            document.getElementById('deskTabSubs').classList.add('active');
            document.getElementById('mobTabSubs').classList.add('active');
            loadData();
        } else if (t === 'pool') {
            document.getElementById('poolCard').classList.add('active');
            document.getElementById('deskTabPool').classList.add('active');
            document.getElementById('mobTabPool').classList.add('active');
            loadPoolData();
        } else if (t === 'admins') {
            document.getElementById('adminsCard').classList.add('active');
            document.getElementById('deskTabAdmins').classList.add('active');
            document.getElementById('mobTabAdmins').classList.add('active');
            loadAdminsData();
        } else if (t === 'stats') {
            document.getElementById('statsCard').classList.add('active');
            document.getElementById('deskTabStats').classList.add('active');
            document.getElementById('mobTabStats').classList.add('active');
            calcStats();
        }
    }

    async function loadData() {
        const tb = document.getElementById('tbody');
        tb.innerHTML = '';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="10" style="text-align:center;padding:20px;">درحال بارگذاری...</td>';
        tb.appendChild(tr);

        let q = '';
        if (currentAdmin && currentAdmin.role === 1) {
            const adm = document.getElementById('searchAdminId').value;
            const start = document.getElementById('searchCreated').value;
            const end = document.getElementById('searchEnded').value;
            
            if (adm) q += '&admin_filter=' + adm;
            if (start) q += '&filter_created=' + start;
            if (end) q += '&filter_ended=' + end;
        }
        const data = await api('/api/data?' + q);
        if (data) {
            tableData = data;
            updateStats();
            filterTable();
        }
    }

    async function loadAdminFilterList() {
        const list = await api('/api/admins-list');
        const s1 = document.getElementById('searchAdminId');
        const s2 = document.getElementById('assignAdminId');
        const s3 = document.getElementById('poolOwnerInput');
        
        s1.innerHTML = '<option value="">همه</option>';
        s2.innerHTML = '<option value="">خودم</option>';
        s3.innerHTML = '<option value="">عمومی</option>';
        
        if (list) {
            list.forEach(function(a) {
                let o1 = document.createElement('option'); o1.value = a.id; o1.text = a.username; s1.appendChild(o1);
                let o2 = document.createElement('option'); o2.value = a.id; o2.text = a.username; s2.appendChild(o2);
                let o3 = document.createElement('option'); o3.value = a.id; o3.text = a.username; s3.appendChild(o3);
            });
        }
    }

    function updateStats() {
        if (!currentAdmin || currentAdmin.role === 1) return;
        const ac = tableData.filter(function(r) { return r.status && new Date(r.ended_at) > new Date(); }).length;
        const mx = currentAdmin.max_subs || '∞';
        const box = document.getElementById('statsBox');
        
        box.style.display = 'block';
        box.innerText = ac + ' / ' + mx;
        box.style.color = (typeof mx === 'number' && ac >= mx) ? '#f87171' : '#34d399';
    }
    
    function calcStats() {
        const now = new Date();
        const activeSubs = tableData.filter(r => r.status && new Date(r.ended_at) > now).length;
        let unsettledPrice = 0;
        
        // Calculate Debt: Sum of (Price) WHERE status=Active AND expired=False AND settlement=Unsettled
        tableData.forEach(r => {
            if (r.status && new Date(r.ended_at) > now && r.settlement_status === 'unsettled') {
                unsettledPrice += (r.price || 0);
            }
        });
        
        document.getElementById('statActiveSubs').innerText = activeSubs;
        document.getElementById('statUnsettledPrice').innerText = unsettledPrice.toLocaleString();
        
        // Admin Performance Table (Only for Role 1)
        if (currentAdmin.role === 1) {
            document.getElementById('adminPerformanceSection').style.display = 'block';
            
            const adminStats = {};
            if(adminsData.length > 0) {
                adminsData.forEach(a => {
                    adminStats[a.id] = { name: a.username, active: 0, debt: 0 };
                });
            }
            
            tableData.forEach(r => {
                if(r.admin_id && adminStats[r.admin_id]) {
                    if(r.status && new Date(r.ended_at) > now) {
                        adminStats[r.admin_id].active++;
                        if (r.settlement_status === 'unsettled') {
                            adminStats[r.admin_id].debt += (r.price || 0);
                        }
                    }
                }
            });
            
            const tb = document.getElementById('statsTbody');
            tb.innerHTML = '';
            Object.values(adminStats).forEach(s => {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td>'+s.name+'</td><td>'+s.active+'</td><td>'+s.debt.toLocaleString()+'</td>';
                tb.appendChild(tr);
            });
        } else {
            document.getElementById('adminPerformanceSection').style.display = 'none';
        }
    }

    function setSubFilter(t) {
        subFilter = t;
        document.getElementById('filterActive').classList.toggle('active', t === 'active');
        document.getElementById('filterExpired').classList.toggle('active', t === 'expired');
        filterTable();
    }

    function filterTable() {
        const now = new Date();
        let f = tableData;
        
        if (currentAdmin.role > 1) {
            const s = document.getElementById('simpleSearch').value.toLowerCase();
            f = f.filter(function(r) { return r.username.toLowerCase().includes(s) || (r.pool && r.pool.name.toLowerCase().includes(s)); });
        }
        
        f = f.filter(function(r) {
            const isEx = new Date(r.ended_at) < now;
            return subFilter === 'active' ? !isEx : isEx;
        });
        
        renderTable(f);
    }
    
    // Helper function for creating icon with tooltip
    function createTooltipIcon(text) {
        const wrap = document.createElement('div');
        wrap.className = 'tooltip-wrap';
        
        const icon = document.createElement('span');
        icon.className = 'material-icons info-icon';
        icon.innerText = 'info_outline'; // 'i' icon
        
        const tooltip = document.createElement('span');
        tooltip.className = 'tooltip-text';
        tooltip.innerText = text;
        
        wrap.appendChild(icon);
        wrap.appendChild(tooltip);
        return wrap;
    }

    function renderTable(d) {
        const tb = document.getElementById('tbody');
        tb.innerHTML = '';
        
        if (d.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="10" style="text-align:center;padding:20px;color:#94a3b8;">خالی</td>';
            tb.appendChild(tr);
            return;
        }
        
        d.forEach(function(r) {
            const tr = document.createElement('tr');
            const pn = r.pool ? r.pool.name : '<span style="color:#ef4444">حذف شده</span>';
            const pu = r.pool ? r.pool.url : 'No URL';
            const isEx = new Date(r.ended_at) < new Date();
            
            let st = r.status ? '<span class="status-badge active">فعال</span>' : '<span class="status-badge inactive">غیرفعال</span>';
            if (isEx) st = '<span class="status-badge expired">منقضی</span>';
            
            let pc = r.payment_status === 'paid' ? '#34d399' : (r.payment_status === 'unpaid' ? '#f87171' : '#fbbf24');
            let pt = r.payment_status === 'paid' ? '✓' : (r.payment_status === 'unpaid' ? '✗' : '?');
            let payBadge = '<span style="color:' + pc + ';font-weight:bold;">' + pt + '</span>';
            
            let sc = r.settlement_status === 'settled' ? '#34d399' : '#f87171';
            let stt = r.settlement_status === 'settled' ? 'تسویه شده' : 'تسویه نشده';

            if (currentAdmin.role === 1) {
                let tdC = document.createElement('td');
                let chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.className = 'sub-check';
                chk.value = r.id;
                tdC.appendChild(chk);
                tr.appendChild(tdC);
            }
            
            let tdAct = document.createElement('td'); 
            tdAct.style.display = 'flex'; 
            
            if (currentAdmin.role > 3) {
                let b = document.createElement('button'); b.className = 'button btn-icon';
                b.innerHTML = '<span class="material-icons" style="font-size:16px;color:#3b82f6;">content_copy</span>';
                b.onclick = function() { openCopyDialog(pu, r.username); };
                tdAct.appendChild(b);
            } else {
                if (subFilter === 'expired' && currentAdmin.role > 1) {
                    tdAct.innerHTML = '<span style="font-size:11px;color:#94a3b8;">غیرمجاز</span>';
                } else {
                    let b1 = document.createElement('button'); b1.className = 'button btn-icon';
                    b1.innerHTML = '<span class="material-icons" style="font-size:16px;">edit</span>';
                    b1.onclick = function() { openSubDialog('edit', r.id); };
                    tdAct.appendChild(b1);
                    
                    if (!isEx && r.status) {
                        let b2 = document.createElement('button'); b2.className = 'button';
                        b2.style = 'background:rgba(245,158,11,0.15);color:#f59e0b;padding:4px 8px;font-size:10px;margin:0 4px;';
                        b2.innerText = 'منقضی';
                        b2.onclick = function() { expireSub(r.id); };
                        tdAct.appendChild(b2);
                    }
                    
                    if (currentAdmin.role === 1) {
                        let b3 = document.createElement('button'); b3.className = 'button btn-icon';
                        b3.innerHTML = '<span class="material-icons" style="font-size:16px;">delete</span>';
                        b3.style.color = '#ef4444';
                        b3.onclick = function() { delItem(r.id); };
                        tdAct.appendChild(b3);
                    }
                    
                    let b4 = document.createElement('button'); b4.className = 'button btn-icon';
                    b4.innerHTML = '<span class="material-icons" style="font-size:16px;color:#3b82f6;">content_copy</span>';
                    b4.onclick = function() { openCopyDialog(pu, r.username); };
                    tdAct.appendChild(b4);
                }
            }

            let tdU = document.createElement('td'); tdU.innerText = r.username;
            
            // Server Column with Icon
            let tdS = document.createElement('td'); 
            tdS.innerHTML = pn + ' '; // Server Name
            if(r.pool) {
               tdS.appendChild(createTooltipIcon(pu)); // Add Icon for URL
            }
            
            let tdStart = document.createElement('td'); 
            tdStart.innerText = new Date(r.created_at).toLocaleDateString('fa-IR');

            // Note Column
            let tdN = document.createElement('td');
            if (r.note && r.note.trim() !== '') {
                tdN.appendChild(createTooltipIcon(r.note));
            } else {
                tdN.innerText = '-';
            }

            let tdCn = document.createElement('td'); tdCn.innerText = r.config_name || '-';
            let tdE = document.createElement('td'); tdE.innerText = new Date(r.ended_at).toLocaleDateString('fa-IR');
            
            // Price Column
            let tdPr = document.createElement('td'); 
            tdPr.innerText = r.price ? r.price.toLocaleString() : '0';

            let tdSt = document.createElement('td'); tdSt.innerHTML = st;
            let tdP = document.createElement('td'); tdP.innerHTML = payBadge;
            let tdSett = document.createElement('td'); tdSett.innerHTML = '<span style="color:' + sc + ';font-size:11px;">' + stt + '</span>';
            
            tr.appendChild(tdAct);
            tr.appendChild(tdU); tr.appendChild(tdS); tr.appendChild(tdStart);
            
            // Issuer Column (Only for Role 1)
            if (currentAdmin.role === 1) {
                let tdA = document.createElement('td');
                tdA.innerText = r.admins ? r.admins.username : '-';
                tr.appendChild(tdA);
            }
            
            tr.appendChild(tdN); tr.appendChild(tdCn);
            tr.appendChild(tdE); tr.appendChild(tdPr);
            tr.appendChild(tdSt); tr.appendChild(tdP); tr.appendChild(tdSett);
            
            tb.appendChild(tr);
        });
    }

    async function loadPoolData() {
        const tb = document.getElementById('poolTbody'); tb.innerHTML = '';
        const d = await api('/api/pool/all');
        if (d) {
            poolData = d;
            if (d.length === 0) {
                tb.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;">خالی</td></tr>';
                return;
            }
            d.forEach(function(p) {
                const tr = document.createElement('tr');
                let own = 'عمومی'; if (p.owner_id) own = 'اختصاصی';
                let act = (p.is_active === false) ? '<span class="status-badge expired">غیرفعال</span>' : '<span class="status-badge active">فعال</span>';
                
                let tdAct = document.createElement('td');
                if (currentAdmin.role <= 2) {
                    let b1 = document.createElement('button'); b1.className = 'button btn-icon';
                    b1.innerHTML = '<span class="material-icons" style="font-size:16px;">edit</span>';
                    b1.onclick = function() { openPoolDialog('edit', p.id); };
                    tdAct.appendChild(b1);
                }
                if (currentAdmin.role === 1) {
                    let b2 = document.createElement('button'); b2.className = 'button btn-icon';
                    b2.innerHTML = '<span class="material-icons" style="font-size:16px;">delete</span>';
                    b2.style.color = '#ef4444';
                    b2.onclick = function() { deletePool(p.id); };
                    tdAct.appendChild(b2);
                }

                tr.innerHTML = '<td>' + p.id + '</td><td>' + p.name + '</td><td style="direction:ltr;max-width:150px;overflow:hidden;text-overflow:ellipsis;">' + p.url + '</td><td>' + (p.note || '-') + '</td><td>' + new Date(p.created_at).toLocaleDateString('fa-IR') + '</td><td>' + act + '</td>';
                tr.appendChild(tdAct);
                tb.appendChild(tr);
            });
        }
    }

    async function loadAdminsData() {
        const tb = document.getElementById('adminTbody'); tb.innerHTML = '';
        const d = await api('/api/admin/crud/list');
        if (d) {
            adminsData = d;
            if (d.length === 0) {
                tb.innerHTML = '<tr><td colspan="6" style="text-align:center;">خالی</td></tr>';
                return;
            }
            d.forEach(function(a) {
                let rn = 'ناشناس';
                if (a.role === 1) rn = 'مدیر کل'; else if (a.role === 2) rn = 'نماینده ارشد'; else if (a.role === 3) rn = 'نماینده عادی'; else if (a.role === 4) rn = 'ناظر';
                let ce = a.can_edit_config_name ? 'بله' : 'خیر';
                
                const tr = document.createElement('tr');
                let tdAct = document.createElement('td');
                let b1 = document.createElement('button'); b1.className = 'button btn-icon';
                b1.innerHTML = '<span class="material-icons" style="font-size:16px;">edit</span>';
                b1.onclick = function() { openAdminDialog('edit', a.id); };
                let b2 = document.createElement('button'); b2.className = 'button btn-icon';
                b2.innerHTML = '<span class="material-icons" style="font-size:16px;">delete</span>';
                b2.style.color = '#ef4444';
                b2.onclick = function() { deleteAdmin(a.id); };
                
                tdAct.appendChild(b1); tdAct.appendChild(b2);
                tr.innerHTML = '<td>' + a.username + '</td><td>' + rn + '</td><td>' + (a.max_subs || '∞') + '</td><td>' + a.default_config_name + '</td><td>' + ce + '</td><td>' + (a.price_1_mo || 0).toLocaleString() + '</td><td>' + (a.price_2_mo || 0).toLocaleString() + '</td><td>' + (a.price_3_mo || 0).toLocaleString() + '</td>';
                tr.appendChild(tdAct);
                tb.appendChild(tr);
            });
        }
    }

    // Actions
    async function openSubDialog(m, id) {
        dialogMode = m;
        document.getElementById('subDialogTitle').innerText = m === 'add' ? 'ثبت جدید' : 'ویرایش';
        const d = document.getElementById('subDialog');
        
        if (currentAdmin.role === 1) {
            document.getElementById('role1Fields').style.display = 'block';
            document.getElementById('assignAdminDiv').style.display = 'block';
        } else {
            document.getElementById('role1Fields').style.display = 'none';
            document.getElementById('assignAdminDiv').style.display = 'none';
        }
        
        const confInput = document.getElementById('subConfigName');
        const confRadios = document.getElementById('configTypeRadios');
        const btnConfDate = document.getElementById('btnConfDate');
        
        // Date Input Locking Logic
        const dateInput = document.getElementById('subEnd');
        if (currentAdmin.role === 1) {
            dateInput.disabled = false;
        } else {
            dateInput.disabled = true;
        }
        
        // Price Input Locking Logic (Updated Requirement 2)
        const priceInput = document.getElementById('subPrice');
        if (currentAdmin.role === 1) {
            priceInput.disabled = false;
        } else {
            priceInput.disabled = true;
        }

        // Logic for Config Name Permission and UI
        if (currentAdmin.role === 1 || currentAdmin.can_edit_config_name) {
            // Full Access
            confInput.disabled = false;
            confRadios.style.display = 'none';
            btnConfDate.style.display = 'block';
        } else {
            // Restricted Access (Role 2/3 without edit permission)
            confInput.disabled = true; // Lock the text input
            confRadios.style.display = 'flex'; // Show radio options
            btnConfDate.style.display = 'none'; // Hide the manual date button
            
            // Set default selection for radios
            document.getElementsByName('confType')[0].checked = true; // Default to 'Default Name'
        }

        if (m === 'add') {
            isNameSynced = true;
            document.getElementById('subId').value = ''; document.getElementById('subUser').value = ''; 
            document.getElementById('subStatus').value = 'true'; document.getElementById('subPayStatus').value = 'paid';
            document.getElementById('subSetStatus').value = 'unsettled'; document.getElementById('subNote').value = '';
            
            document.getElementById('subPrice').value = ''; // Reset price
            
            // Initial Config Name Logic
            document.getElementById('subConfigName').value = currentAdmin.default_config_name || '@TutiVpn';
            
            addTime(1);
            document.getElementById('poolSelectDiv').style.display = 'flex'; document.getElementById('poolNameDiv').style.display = 'none';
            if (currentAdmin.role === 1) document.getElementById('assignAdminId').value = "";
            const pls = await api('/api/pool/available'); const sel = document.getElementById('subPoolId'); sel.innerHTML = '';
            if (pls && pls.length > 0) pls.forEach(function(p) { let o = document.createElement('option'); o.value = p.id; o.text = p.name; sel.appendChild(o); });
            else sel.innerHTML = '<option value="">خالی</option>';
        } else {
            const i = tableData.find(function(x) { return x.id === id; });
            isNameSynced = false;
            document.getElementById('subId').value = i.id; document.getElementById('subUser').value = i.username;
            document.getElementById('subEnd').value = i.ended_at.slice(0, 16); document.getElementById('subStatus').value = i.status.toString();
            document.getElementById('subPayStatus').value = i.payment_status || 'paid';
            document.getElementById('subSetStatus').value = i.settlement_status || 'unsettled';
            document.getElementById('subNote').value = i.note || ''; document.getElementById('subConfigName').value = i.config_name || '';
            document.getElementById('subPrice').value = i.price || 0;
            
            document.getElementById('poolSelectDiv').style.display = 'none'; document.getElementById('poolNameDiv').style.display = 'flex';
            document.getElementById('subPoolName').value = i.pool ? i.pool.name : 'Unknown';
            if (currentAdmin.role === 1) document.getElementById('assignAdminId').value = i.admin_id;
        }
        d.classList.add('active');
    }
    
    // New function to handle Radio Button change for restricted admins
    function updateConfigNameBasedOnSelection() {
        const radios = document.getElementsByName('confType');
        const confInput = document.getElementById('subConfigName');
        
        if (radios[0].checked) {
            // Default Selected
            confInput.value = currentAdmin.default_config_name || '@TutiVpn';
        } else if (radios[1].checked) {
            // Date Selected
            setConfDate(); // Force update from current date input
        }
    }

    function setConfDate() {
        // This is called by the manual button OR by the radio logic
        isNameSynced = true;
        const end = document.getElementById('subEnd').value;
        if (end) document.getElementById('subConfigName').value = new Date(end).toLocaleDateString('fa-IR').replace(/\\//g, '-');
    }

    async function saveSub() {
        const id = document.getElementById('subId').value;
        const u = document.getElementById('subUser').value;
        const e = document.getElementById('subEnd').value;
        const s = document.getElementById('subStatus').value === 'true';
        const p = document.getElementById('subPoolId').value;
        const aa = document.getElementById('assignAdminId').value;
        const pay = document.getElementById('subPayStatus').value;
        const set = document.getElementById('subSetStatus').value;
        const note = document.getElementById('subNote').value;
        const conf = document.getElementById('subConfigName').value;
        const pr = document.getElementById('subPrice').value;

        if (!u || !e) return toast('خالی');
        if (new Date(e) < new Date() && s && dialogMode === 'add') return toast('تاریخ گذشته');
        
        const btn = document.getElementById('saveSubBtn'); btn.innerText = '...'; btn.disabled = true;
        
        const py = { 
            username: u, 
            ended_at: e, 
            status: s, 
            payment_status: pay, 
            config_name: conf, 
            note: note,
            price: pr
        };
        
        if (currentAdmin.role === 1) py.settlement_status = set;
        
        let ur = '/api/update', me = 'PUT';
        if (dialogMode === 'add') { 
            ur = '/api/add'; me = 'POST'; py.pool_id = p; 
            if (currentAdmin.role === 1 && aa) py.admin_id = aa; 
        } else { 
            py.id = id; 
            if (currentAdmin.role === 1 && aa) py.admin_id = aa; 
        }
        
        const res = await fetch(ur, { method: me, body: JSON.stringify(py), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        btn.innerText = 'ذخیره'; btn.disabled = false;
        
        if (res.ok) { 
            toast('انجام شد'); closeDialog('subDialog'); loadData(); 
        } else { 
            const er = await res.json(); toast(er.error || 'خطا'); 
        }
    }

    // Bulk Actions
    function openBulkDialog() { document.getElementById('bulkDialog').classList.add('active'); }
    function toggleAllChecks(source) { document.querySelectorAll('.sub-check').forEach(function(c) { c.checked = source.checked; }); }
    
    async function submitBulk() {
        const scope = document.getElementById('bulkScope').value;
        const type = document.getElementById('bulkActionType').value;
        const days = parseInt(document.getElementById('bulkDays').value);
        let ids = [];
        
        if (scope === 'selected') {
            document.querySelectorAll('.sub-check:checked').forEach(function(c) { ids.push(c.value); });
        } else {
            tableData.forEach(function(r) { if (r.status) ids.push(r.id); });
        }
        
        if (ids.length === 0) return toast('موردی انتخاب نشده');
        
        const btn = document.querySelector('#bulkDialog .btn-primary'); btn.innerText = '...'; btn.disabled = true;
        const res = await fetch('/api/bulk-update', {
            method: 'POST',
            body: JSON.stringify({ ids: ids, type: type, days: days }),
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }
        });
        
        if (res.ok) { toast('بروزرسانی شد'); closeDialog('bulkDialog'); loadData(); } else toast('خطا');
        btn.innerText = 'اجرا'; btn.disabled = false;
    }

    // Common Actions
    async function expireSub(id) {
        if (confirm('منقضی؟')) {
            const res = await fetch('/api/update', {
                method: 'PUT',
                body: JSON.stringify({ id: id, ended_at: new Date().toISOString(), status: false }),
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            if (res.ok) { toast('انجام شد'); loadData(); } else toast('خطا');
        }
    }
    
    async function delItem(id) {
        if (confirm('حذف؟')) {
            const res = await fetch('/api/delete?id=' + id, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            if (res.ok) { toast('حذف شد'); loadData(); } else toast('خطا');
        }
    }

    function openPoolDialog(m, id) {
        poolDialogMode = m; document.getElementById('poolDialogTitle').innerText = m === 'add' ? 'ثبت سرور' : 'ویرایش';
        if (currentAdmin.role === 1) document.getElementById('poolOwnerDiv').style.display = 'block'; else document.getElementById('poolOwnerDiv').style.display = 'none';
        
        // Show/Hide Active Checkbox based on Role
        const activeDiv = document.getElementById('poolActiveDiv');
        if (currentAdmin.role <= 2) {
            activeDiv.style.display = 'flex';
        } else {
            activeDiv.style.display = 'none';
        }
        
        if (m === 'add') { 
            document.getElementById('poolId').value = ''; document.getElementById('poolNameInput').value = ''; 
            document.getElementById('poolUrlInput').value = ''; document.getElementById('poolNoteInput').value = '';
            if (currentAdmin.role === 1) document.getElementById('poolOwnerInput').value = "";
            document.getElementById('poolActiveInput').checked = true; // Default Active
        } else { 
            const p = poolData.find(function(x) { return x.id === id; });
            document.getElementById('poolId').value = p.id; document.getElementById('poolNameInput').value = p.name; 
            document.getElementById('poolUrlInput').value = p.url; document.getElementById('poolNoteInput').value = p.note || '';
            if (currentAdmin.role === 1) document.getElementById('poolOwnerInput').value = p.owner_id || "";
            if (p.is_active !== undefined) document.getElementById('poolActiveInput').checked = p.is_active;
        }
        document.getElementById('poolDialog').classList.add('active');
    }
    
    async function savePool() {
        const id = document.getElementById('poolId').value;
        const n = document.getElementById('poolNameInput').value;
        const u = document.getElementById('poolUrlInput').value;
        const no = document.getElementById('poolNoteInput').value;
        const ow = document.getElementById('poolOwnerInput').value;
        const ac = document.getElementById('poolActiveInput').checked;
        
        if (!n || !u) return toast('الزامی');
        
        let ur = '/api/pool/add', me = 'POST', py = { name: n, url: u, note: no };
        
        // Only roles 1 and 2 can change active status
        if (currentAdmin.role <= 2) {
            py.is_active = ac;
        }
        
        if (currentAdmin.role === 1) py.owner_id = ow;
        
        if (poolDialogMode === 'edit') { ur = '/api/pool/update'; me = 'PUT'; py.id = id; }
        
        const res = await fetch(ur, { method: me, body: JSON.stringify(py), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        if (res.ok) { toast('انجام شد'); closeDialog('poolDialog'); loadPoolData(); } else { const er = await res.json(); toast(er.error || 'خطا'); }
    }
    
    async function deletePool(id) {
        if (confirm('حذف؟')) {
            const res = await fetch('/api/pool/delete?id=' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
            if (res.ok) { toast('حذف شد'); loadPoolData(); } else toast('خطا');
        }
    }

    function openAdminDialog(m, id) {
        adminDialogMode = m; document.getElementById('adminDialogTitle').innerText = m === 'add' ? 'ثبت همکار' : 'ویرایش';
        if (m === 'add') { 
            document.getElementById('adminId').value = ''; document.getElementById('adminUserInput').value = ''; 
            document.getElementById('adminPassInput').value = ''; document.getElementById('adminRoleInput').value = '2'; 
            document.getElementById('adminMaxInput').value = '50'; document.getElementById('adminDefConfInput').value = '@TutiVpn';
            document.getElementById('adminCanEditConfInput').checked = false;
            
            document.getElementById('adminPrice1').value = '0';
            document.getElementById('adminPrice2').value = '0';
            document.getElementById('adminPrice3').value = '0';
        } else { 
            const a = adminsData.find(function(x) { return x.id === id; });
            document.getElementById('adminId').value = a.id; document.getElementById('adminUserInput').value = a.username;
            document.getElementById('adminPassInput').value = ''; document.getElementById('adminRoleInput').value = a.role;
            document.getElementById('adminMaxInput').value = a.max_subs; document.getElementById('adminDefConfInput').value = a.default_config_name;
            document.getElementById('adminCanEditConfInput').checked = a.can_edit_config_name;
            
            document.getElementById('adminPrice1').value = a.price_1_mo || 0;
            document.getElementById('adminPrice2').value = a.price_2_mo || 0;
            document.getElementById('adminPrice3').value = a.price_3_mo || 0;
        }
        document.getElementById('adminDialog').classList.add('active');
    }
    
    async function saveAdmin() {
        const id = document.getElementById('adminId').value;
        const u = document.getElementById('adminUserInput').value;
        const p = document.getElementById('adminPassInput').value;
        const r = document.getElementById('adminRoleInput').value;
        const mx = document.getElementById('adminMaxInput').value;
        const dcn = document.getElementById('adminDefConfInput').value;
        const cec = document.getElementById('adminCanEditConfInput').checked;
        
        const pr1 = document.getElementById('adminPrice1').value;
        const pr2 = document.getElementById('adminPrice2').value;
        const pr3 = document.getElementById('adminPrice3').value;
        
        if (!u) return toast('الزامی');
        
        let ur = '/api/admin/crud/add', me = 'POST', py = { 
            username: u, 
            password: p, 
            role: r, 
            max_subs: mx, 
            default_config_name: dcn, 
            can_edit_config_name: cec,
            price_1_mo: pr1,
            price_2_mo: pr2,
            price_3_mo: pr3
        };
        
        if (adminDialogMode === 'edit') { ur = '/api/admin/crud/update'; me = 'PUT'; py.id = id; }
        
        const res = await fetch(ur, { method: me, body: JSON.stringify(py), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        if (res.ok) { toast('انجام شد'); closeDialog('adminDialog'); loadAdminsData(); } else { const er = await res.json(); toast(er.error || 'خطا'); }
    }
    
    async function deleteAdmin(id) {
        if (confirm('حذف؟')) {
            const res = await fetch('/api/admin/crud/delete?id=' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
            if (res.ok) { toast('حذف شد'); loadAdminsData(); } else { const er = await res.json(); toast(er.error || 'خطا'); }
        }
    }

    async function api(u) {
        try {
            const r = await fetch(u, { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
            if (r.status === 401 || r.status === 403) return null;
            return await r.json();
        } catch (e) {
            return null;
        }
    }
    
    function closeDialog(i) { document.getElementById(i).classList.remove('active'); }
    function toast(m) { const t = document.getElementById('toast'); t.innerText = m; t.classList.add('show'); setTimeout(function() { t.classList.remove('show'); }, 3000); }
    function randomUser() { document.getElementById('subUser').value = 'u_' + Math.random().toString(36).substring(7); }
    
    // Updated addTime function with fixed days logic and PRICE LOGIC
    function addTime(months) {
        const d = new Date();
        let daysToAdd = 30; // Default fallback
        let price = 0;

        if (months === 1) {
            daysToAdd = 31;
            if (currentAdmin) price = currentAdmin.price_1_mo || 0;
        } else if (months === 2) {
            daysToAdd = 61;
            if (currentAdmin) price = currentAdmin.price_2_mo || 0;
        } else if (months === 3) {
            daysToAdd = 91;
            if (currentAdmin) price = currentAdmin.price_3_mo || 0;
        }

        // Set Price Field
        const priceInput = document.getElementById('subPrice');
        if (priceInput) priceInput.value = price;

        d.setDate(d.getDate() + daysToAdd);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        document.getElementById('subEnd').value = d.toISOString().slice(0, 16);
        
        const radios = document.getElementsByName('confType');
        const isDateSelected = radios.length > 0 && radios[1].checked;
        
        if ((currentAdmin && (currentAdmin.role === 1 || currentAdmin.can_edit_config_name) && isNameSynced) || isDateSelected) {
            setConfDate();
        }
    }
    
    function copyTxt(u, n) { navigator.clipboard.writeText(u + n).then(function() { toast('کپی شد'); }); }
    
    // New Copy Logic
    function openCopyDialog(url, username) {
        currentCopyBase = url + username;
        document.getElementById('copyDialog').classList.add('active');
    }
    
    function copyMain() {
        navigator.clipboard.writeText(currentCopyBase).then(function() { toast('لینک اصلی کپی شد'); });
    }
    
    function copySub() {
        navigator.clipboard.writeText(currentCopyBase + '?sub').then(function() { toast('لینک Sub کپی شد'); });
    }
    
    function copyClash() {
        navigator.clipboard.writeText(currentCopyBase + '?clash').then(function() { toast('لینک Clash کپی شد'); });
    }
  </script>
</body>
</html>
  `;
}
